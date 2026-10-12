import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { resolveConfigDir } from '../../config/namespace.mjs'
import { SessionPersistenceQueue } from '../persistence-queue'
import { getSessionFilePath, ensureSessionDir, listSessions } from '../storage'
import { readSessionJsonl, writeSessionJsonl } from '../jsonl'
import type { StoredSession } from '../types'
import { replaceFileDurably } from '../atomic-file'

const tick = () => new Promise(resolve => setTimeout(resolve, 15))
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
describe('real queue durability', () => {
  let root: string
  const queues: SessionPersistenceQueue[] = []
  beforeEach(() => { root = mkdtempSync(join(resolveConfigDir(), 't05-queue-')) })
  afterEach(async () => {
    for (const queue of queues.splice(0)) { await queue.discardAndWait('session-a') }
    const offset = relative(realpathSync.native(resolveConfigDir()), realpathSync.native(root))
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned cleanup boundary')
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
  function session(name = 'A'): StoredSession {
    return { id: 'session-a', workspaceRootPath: root, createdAt: 1, lastUsedAt: 2, name,
      messages: [{ id: 'm1', type: 'assistant', content: name, toolInput: { values: [1] }, turnId: 'turn-a' }],
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 } }
  }
  function queue(writer?: (file: string, content: string, current: () => boolean) => Promise<void>) {
    const q = new SessionPersistenceQueue(1, writer); queues.push(q); return q
  }
  test('flush and flushAll wait for debounce writes after pending was consumed', async () => {
    const entered = gate(), finish = gate()
    const q = queue(async () => { entered.release(); await finish.promise })
    q.enqueue(session()); await entered.promise
    let flushed = false, all = false
    const one = q.flush('session-a').then(() => { flushed = true })
    const every = q.flushAll().then(() => { all = true })
    await tick(); const early = flushed || all
    finish.release(); await Promise.all([one, every])
    expect(early).toBe(false)
  })
  test('failed writes reject and do not claim a written signature', async () => {
    const q = queue(async () => { throw Error('synthetic failure') })
    q.enqueue(session())
    let failed = false
    try { await q.flush('session-a') } catch { failed = true }
    expect(failed).toBe(true)
    expect(q.getLastWrittenSignature('session-a')).toBeUndefined()
  })
  test('enqueue captures its own snapshot and serializes later generations', async () => {
    const entered = gate(), finish = gate(), saved: string[] = []
    const q = queue(async (_file, content) => { if (!saved.length) { entered.release(); await finish.promise }; saved.push(content) })
    const first = session('first'); q.enqueue(first); first.messages[0]!.content = 'mutated'
    await entered.promise
    q.enqueue(session('second')); const flushed = q.flush('session-a')
    finish.release(); await flushed
    expect(JSON.parse(saved[0]!.split('\n')[1]!).content).toBe('first')
    expect(JSON.parse(saved.at(-1)!.split('\n')[1]!).content).toBe('second')
  })
  test('startup local metadata wins; external edits after a committed signature survive', async () => {
    const data = session('disk'); ensureSessionDir(root, data.id)
    const file = getSessionFilePath(root, data.id); writeSessionJsonl(file, data)
    const q = queue(); q.enqueue(session('local')); await q.flush(data.id)
    expect(readSessionJsonl(file)?.name).toBe('local')
    writeSessionJsonl(file, session('external'))
    q.enqueue(session('stale')); await q.flush(data.id)
    expect(readSessionJsonl(file)?.name).toBe('external')
    expect(readSessionJsonl(file)?.messages[0]?.content).toBe('stale')
  })
  test('listing and both writers preserve an unknown legacy tmp', async () => {
    const data = session(); ensureSessionDir(root, data.id)
    const file = getSessionFilePath(root, data.id); writeSessionJsonl(file, data)
    writeFileSync(file + '.tmp', 'unique unknown recovery copy')
    listSessions(root); expect(readFileSync(file + '.tmp', 'utf8')).toBe('unique unknown recovery copy')
    writeSessionJsonl(file, session('sync'))
    expect(readFileSync(file + '.tmp', 'utf8')).toBe('unique unknown recovery copy')
    const q = queue(); q.enqueue(session('async')); await q.flush(data.id)
    expect(readFileSync(file + '.tmp', 'utf8')).toBe('unique unknown recovery copy')
  })
  test('rename failure leaves old target and a complete unique temp; flushAll reports failure', async () => {
    const data = session('old'); ensureSessionDir(root, data.id)
    const file = getSessionFilePath(root, data.id); writeSessionJsonl(file, data)
    const original = readFileSync(file, 'utf8')
    const q = queue((file, content, current) => replaceFileDurably(file, content, current, async () => { throw Error('synthetic rename failure') }))
    q.enqueue(session('new'))
    let failed = false; try { await q.flush('session-a') } catch { failed = true }; expect(failed).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(original)
    const tmp = readdirSync(join(root, 'sessions', data.id)).find(name => name.startsWith('session.jsonl.tmp-'))!
    expect(readFileSync(join(root, 'sessions', data.id, tmp), 'utf8')).toContain('new')
    expect(q.getLastWrittenSignature(data.id)).toBeUndefined()
    let allFailed = false; try { await q.flushAll() } catch { allFailed = true }; expect(allFailed).toBe(true)
  })
  test('cancel can replace a watcher generation; deletion waits and blocks revival', async () => {
    const entered = gate(), finish = gate(), saved: string[] = []
    let calls = 0
    const q = queue(async (_file, content, current) => {
      if (++calls === 1) { entered.release(); await finish.promise }
      if (!current()) throw Error('cancelled')
      saved.push(content)
    })
    q.enqueue(session('old')); await entered.promise
    q.cancel('session-a'); q.enqueue(session('watcher replacement'))
    const flushed = q.flush('session-a'); finish.release(); await flushed
    expect(saved.length).toBe(1); expect(saved[0]).toContain('watcher replacement')
    await q.discardAndWait('session-a')
    expect(() => q.enqueue(session('revival'))).toThrow()
  })
  test('discard waits for an in-flight writer before the caller deletes its directory', async () => {
    const entered = gate(), finish = gate()
    const q = queue(async (_file, _content, current) => { entered.release(); await finish.promise; if (!current()) throw Error('cancelled') })
    q.enqueue(session()); await entered.promise
    let deleted = false
    const deletion = q.discardAndWait('session-a').then(() => { deleted = true })
    await tick(); expect(deleted).toBe(false)
    finish.release(); await deletion; expect(deleted).toBe(true)
  })
  test('a cancelled flush cannot be acknowledged by the replacement epoch', async () => {
    const entered = gate(), finish = gate(); let calls = 0
    const q = queue(async (_file, _content, current) => {
      if (++calls === 1) { entered.release(); await finish.promise }
      if (!current()) throw Error('cancelled')
    })
    q.enqueue(session()); await entered.promise
    const oldFlush = q.flush('session-a').then(() => false, () => true)
    q.cancel('session-a'); q.enqueue(session('replacement'))
    const replacement = q.flush('session-a'); finish.release()
    expect(await oldFlush).toBe(true); await replacement
  })
})
