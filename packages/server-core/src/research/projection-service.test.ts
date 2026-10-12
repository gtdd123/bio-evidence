import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync, readdirSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, relative, sep, isAbsolute } from 'node:path'
import { replaceFileDurably } from '@craft-agent/shared/sessions/atomic-file'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
import { getSessionFilePath, ensureSessionDir, type StoredSession } from '@craft-agent/shared/sessions'
import { readSessionJsonl, createSessionHeader } from '@craft-agent/shared/sessions/jsonl'
import { SqliteResearchRepository } from './sqlite-repository'
import { SessionProjectionService } from './projection-service'
import type { JsonValue } from '@bio-evidence/research-core'

const actor = { userId: 'alice', authSessionId: 'auth-a', active: true, administrator: false }
const scope = { kind: 'personal', ownerId: 'alice' } as const
describe('authoritative full-snapshot JSONL projection', () => {
  let root: string, repo: SqliteResearchRepository, service: SessionProjectionService
  beforeEach(() => {
    root = mkdtempSync(join(resolveConfigDir(), 't05-projection-'))
    repo = new SqliteResearchRepository(join(root, 'research.sqlite'))
    repo.seedUser({ id: 'alice', username: 'alice', passwordHash: 'synthetic-hash', active: true, administrator: false, revision: 1 })
    repo.put(actor, 'session', { id: 'session-a', ownerId: 'alice', scope, policy: 'restricted', name: 'Local', revision: 1, createdAt: 1 })
    service = new SessionProjectionService(repo, () => root)
  })
  afterEach(() => {
    repo.close()
    const offset = relative(realpathSync.native(resolveConfigDir()), realpathSync.native(root))
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned cleanup boundary')
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
  function session(content = 'Output'): StoredSession {
    return { id: 'session-a', workspaceRootPath: root, createdAt: 1, lastUsedAt: 2, sdkCwd: join(root, 'sdk'), sdkSessionId: 'sdk-session',
      model: 'synthetic-model', llmConnection: 'synthetic-connection', connectionLocked: true, previousPermissionMode: 'safe', hasUnread: true,
      projectId: 'project-a', taskRunId: 'task-a', branchFromSdkSessionId: 'parent-a',
      pendingPlanExecution: { planPath: join(root, 'plan.md'), awaitingCompaction: true },
      messages: [{ id: 'm1', type: 'assistant', content, toolInput: { values: [1, 2] }, turnId: 'turn-a', annotations: [] }],
      tokenUsage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 3, costUsd: 0, contextTokens: 0 } }
  }
  function append(data: StoredSession, operation = 'operation-a', generation = 1) {
    const header = JSON.parse(JSON.stringify({ ...createSessionHeader(data), lastUsedAt: data.lastUsedAt }))
    return repo.appendProjectionSnapshot(actor, data.id, operation, header, JSON.parse(JSON.stringify(data.messages)) as JsonValue[], generation)
  }
  test('restart rebuilds full fields and StoredMessage type without duplicate histories', async () => {
    const data = session(); append(data)
    repo.close(); repo = new SqliteResearchRepository(join(root, 'research.sqlite')); service = new SessionProjectionService(repo, () => root)
    await service.reconcile(actor, data.id); await service.reconcile(actor, data.id)
    const restored = readSessionJsonl(getSessionFilePath(root, data.id))!
    expect(restored.messages).toEqual(data.messages)
    for (const field of ['sdkCwd', 'sdkSessionId', 'model', 'llmConnection', 'connectionLocked', 'previousPermissionMode', 'hasUnread',
      'projectId', 'taskRunId', 'branchFromSdkSessionId', 'pendingPlanExecution'] as const) expect(restored[field]).toEqual(data[field])
    expect(repo.readProjection(actor, data.id)[0]?.projected).toBe(true)
  })
  test('empty histories, duplicate operations and same-ID revisions are full snapshots', async () => {
    const data = session(); data.messages = []; append(data)
    await service.reconcile(actor, data.id); expect(readSessionJsonl(getSessionFilePath(root, data.id))?.messages).toEqual([])
    const updated = session('edited'); const seq = append(updated, 'operation-b', 2)
    expect(append(updated, 'operation-b', 2)).toBe(seq)
    await service.reconcile(actor, data.id)
    expect(readSessionJsonl(getSessionFilePath(root, data.id))?.messages).toEqual(updated.messages)
    expect(() => append(session('conflict'), 'operation-b', 2)).toThrow()
    expect(() => append(session('old'), 'operation-c', 1)).toThrow()
  })
  test('old formal file plus matching complete tmp is recovered; unknown bad tmp survives', async () => {
    append(session()); await service.reconcile(actor, 'session-a')
    const file = getSessionFilePath(root, 'session-a'), old = readFileSync(file, 'utf8')
    append(session('new'), 'operation-b', 2); await service.reconcile(actor, 'session-a')
    const latest = readFileSync(file, 'utf8')
    writeFileSync(file + '.tmp-complete', latest); writeFileSync(file + '.tmp', 'only unknown copy'); writeFileSync(file, old)
    await service.reconcile(actor, 'session-a')
    expect(readFileSync(file, 'utf8')).toBe(latest)
    expect(existsSync(file + '.tmp-complete')).toBe(false)
    expect(readFileSync(file + '.tmp', 'utf8')).toBe('only unknown copy')
  })
  test('bad formal file and partial tmp rebuild from journal without destroying unknown copies', async () => {
    append(session()); ensureSessionDir(root, 'session-a'); const file = getSessionFilePath(root, 'session-a')
    writeFileSync(file, 'unknown formal data'); writeFileSync(file + '.tmp-partial', '{partial')
    await service.reconcile(actor, 'session-a')
    expect(readSessionJsonl(file)?.messages).toEqual(session().messages)
    expect(readFileSync(file + '.tmp-partial', 'utf8')).toBe('{partial')
    expect(readdirSync(join(root, 'sessions', 'session-a')).some(name => name.includes('quarantine'))).toBe(true)
  })
  test('projection acknowledgement requires the latest operation, generation and hash', () => {
    append(session()); const entry = repo.readProjection(actor, 'session-a')[0]!
    expect(() => repo.markProjected(actor, 'session-a', entry.operationId, 2, entry.hash)).toThrow()
    expect(() => repo.markProjected(actor, 'session-a', entry.operationId, 1, '0'.repeat(64))).toThrow()
    append(session('new'), 'operation-b', 2)
    expect(() => repo.markProjected(actor, 'session-a', entry.operationId, 1, entry.hash)).toThrow()
    expect(repo.readProjection(actor, 'session-a').every(entry => !entry.projected)).toBe(true)
  })
  test('legacy runtime-only journal cannot silently invent the missing session header', async () => {
    repo.appendProjection(actor, 'session-a', 'legacy-a', [{ id: 'm1', role: 'assistant', content: 'Legacy', timestamp: 1 }], 1)
    let rejected = false; try { await service.reconcile(actor, 'session-a') } catch { rejected = true }
    expect(rejected).toBe(true); expect(repo.readProjection(actor, 'session-a')[0]?.projected).toBe(false)
  })
  test('failed replacement remains pending; interrupted post-replace acknowledgement recovers', async () => {
    const data = session()
    const broken = new SessionProjectionService(repo, () => root, (file, content, current) => replaceFileDurably(file, content, current,
      async () => { throw Error('synthetic rename failure') }))
    let failed = false; try { await broken.save(actor, data, 'operation-a', 1) } catch { failed = true }
    expect(failed).toBe(true); expect(repo.readProjection(actor, data.id)[0]?.projected).toBe(false)
    await service.reconcile(actor, data.id)
    expect(repo.readProjection(actor, data.id)[0]?.projected).toBe(true)
    const interrupted = new SessionProjectionService(repo, () => root, async (file, content, current) => {
      await replaceFileDurably(file, content, current); throw Error('synthetic post-replace interruption')
    })
    failed = false; try { await interrupted.save(actor, session('new'), 'operation-b', 2) } catch { failed = true }
    expect(failed).toBe(true); expect(repo.readProjection(actor, data.id)[1]?.projected).toBe(false)
    await service.reconcile(actor, data.id)
    expect(repo.readProjection(actor, data.id)[1]?.projected).toBe(true)
    expect(readSessionJsonl(getSessionFilePath(root, data.id))?.messages[0]?.content).toBe('new')
  })
  test('trusted workspace binding is used instead of a journal-supplied path', async () => {
    const data = session(); data.workspaceRootPath = join(root, 'unbound-root')
    let failed = false; try { await service.save(actor, data, 'operation-a', 1) } catch { failed = true }
    expect(failed).toBe(true); expect(repo.readProjection(actor, 'session-a')).toEqual([])
  })
  test('same-namespace session junction cannot overwrite another scoped directory', async () => {
    append(session()); mkdirSync(join(root, 'sessions'), { recursive: true })
    const other = join(root, 'other-workspace'); mkdirSync(other)
    const otherFile = join(other, 'session.jsonl'); writeFileSync(otherFile, 'other scope data')
    symlinkSync(other, join(root, 'sessions', 'session-a'), process.platform === 'win32' ? 'junction' : 'dir')
    let rejected = false; try { await service.reconcile(actor, 'session-a') } catch { rejected = true }
    expect(rejected).toBe(true); expect(readFileSync(otherFile, 'utf8')).toBe('other scope data')
    expect(repo.readProjection(actor, 'session-a')[0]?.projected).toBe(false)
  })
  test('a temporary junction to another directory is rejected and retained', async () => {
    append(session()); ensureSessionDir(root, 'session-a')
    const other = join(root, 'other-workspace'); mkdirSync(other); writeFileSync(join(other, 'unique.txt'), 'keep other scope')
    const alias = getSessionFilePath(root, 'session-a') + '.tmp-alias'
    symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir')
    let rejected = false; try { await service.reconcile(actor, 'session-a') } catch { rejected = true }
    expect(rejected).toBe(true); expect(existsSync(alias)).toBe(true)
    expect(readFileSync(join(other, 'unique.txt'), 'utf8')).toBe('keep other scope')
  })
  test('another project editor can read but cannot project or confirm the owner session', async () => {
    const bob = { ...actor, userId: 'bob', authSessionId: 'auth-b' }
    repo.seedUser({ id: 'bob', username: 'bob', passwordHash: 'synthetic-hash', active: true, administrator: false, revision: 1 })
    repo.createProject(actor, 'project-a', 'Project'); repo.setMember(actor, 'project-a', 'bob', 'editor', true, 1)
    repo.put(actor, 'session', { id: 'project-session', ownerId: 'alice', scope: { kind: 'project', projectId: 'project-a' },
      policy: 'restricted', name: 'Local', revision: 1, createdAt: 1 })
    const data = { ...session(), id: 'project-session' }; append(data)
    const entry = repo.readProjection(bob, data.id)[0]!
    expect(entry.messages).toEqual(JSON.parse(JSON.stringify(data.messages)))
    expect(() => service.reconcile(bob, data.id)).toThrow()
    expect(() => repo.markProjected(bob, data.id, entry.operationId, entry.generation, entry.hash)).toThrow()
    expect(existsSync(getSessionFilePath(root, data.id))).toBe(false)
  })
  test('membership revocation while a writer waits rejects replacement and confirmation', async () => {
    const bob = { ...actor, userId: 'bob', authSessionId: 'auth-b' }
    repo.seedUser({ id: 'bob', username: 'bob', passwordHash: 'synthetic-hash', active: true, administrator: false, revision: 1 })
    repo.createProject(bob, 'project-a', 'Project'); repo.setMember(bob, 'project-a', 'alice', 'editor', true, 1)
    repo.put(actor, 'session', { id: 'project-session', ownerId: 'alice', scope: { kind: 'project', projectId: 'project-a' },
      policy: 'restricted', name: 'Local', revision: 1, createdAt: 1 })
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
    const controlled = new SessionProjectionService(repo, () => root, async (file, content, current) => {
      entered(); await waiting; await replaceFileDurably(file, content, current)
    })
    const data = { ...session(), id: 'project-session' }
    const result = controlled.save(actor, data, 'operation-a', 1).then(() => false, () => true)
    await ready
    try { repo.setMember(bob, 'project-a', 'alice', 'editor', false, 2) } finally { release() }
    expect(await result).toBe(true)
    expect(repo.readProjection(bob, data.id)[0]?.projected).toBe(false)
    expect(existsSync(getSessionFilePath(root, data.id))).toBe(false)
  })
  test('concurrent saves reject the superseded generation and persist only the latest snapshot', async () => {
    let release!: () => void, entered!: () => void, calls = 0
    const waiting = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
    const controlled = new SessionProjectionService(repo, () => root, async (file, content, current) => {
      if (++calls === 1) { entered(); await waiting }; await replaceFileDurably(file, content, current)
    })
    const old = controlled.save(actor, session('old'), 'operation-a', 1).then(() => false, () => true)
    await ready; const latest = controlled.save(actor, session('latest'), 'operation-b', 2); release()
    expect(await old).toBe(true); await latest
    expect(repo.readProjection(actor, 'session-a').map(entry => entry.projected)).toEqual([false, true])
    expect(readSessionJsonl(getSessionFilePath(root, 'session-a'))?.messages).toEqual(session('latest').messages)
  })
})
