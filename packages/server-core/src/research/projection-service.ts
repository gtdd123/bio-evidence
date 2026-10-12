import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync, realpathSync, readFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path'
import { IdSchema, parseContract, ResearchError, type Actor, type ResearchRepository, type ProjectionEntry, type JsonValue } from '@bio-evidence/research-core'
import { getSessionFilePath, type StoredSession } from '@craft-agent/shared/sessions'
import { createSessionHeader, makeSessionPathPortable } from '@craft-agent/shared/sessions/jsonl'
import { replaceFileDurably } from '@craft-agent/shared/sessions/atomic-file'
import { resolveConfigDir, validateNamespacePath } from '@craft-agent/shared/config/namespace'
import { expandPath } from '@craft-agent/shared/utils/paths'

type Writer = (file: string, content: string, current: () => boolean) => Promise<void>
/** Bun service component; only trusted service code supplies the workspace binding. */
export class SessionProjectionService {
  private active = new Map<string, Promise<void>>()
  constructor(private readonly repository: ResearchRepository, private readonly workspace: (id: string) => string,
    private readonly writer: Writer = replaceFileDurably) {}

  async save(actor: Actor, session: StoredSession, operationId: string, generation: number): Promise<void> {
    const root = this.checked(this.workspace(parseContract(IdSchema, session.id)))
    if (resolve(session.workspaceRootPath) !== root) throw new ResearchError('BIO_INPUT_INVALID')
    // createSessionHeader preserves SESSION_PERSISTENT_FIELDS. Fix the save
    // timestamp to the supplied snapshot, so an operation retry has identical bytes.
    const header = JSON.parse(JSON.stringify({ ...createSessionHeader(session), lastUsedAt: session.lastUsedAt }))
    const messages = JSON.parse(JSON.stringify(session.messages)) as JsonValue[]
    this.repository.appendProjectionSnapshot(actor, session.id, operationId, header, messages, generation)
    await this.reconcile(actor, session.id)
  }

  reconcile(actor: Actor, sessionId: string): Promise<void> {
    parseContract(IdSchema, sessionId)
    // Read even when coalescing to avoid another actor borrowing an authorized task.
    this.repository.readProjection(actor, sessionId, true)
    const previous = this.active.get(sessionId)
    const work = (previous ?? Promise.resolve()).catch(() => {}).then(() => this.project(actor, sessionId))
      .finally(() => { if (this.active.get(sessionId) === work) this.active.delete(sessionId) })
    this.active.set(sessionId, work)
    return work
  }

  private checked(path: string): string {
    const absolute = validateNamespacePath(resolve(path)), base = realpathSync.native(resolveConfigDir())
    let ancestor = absolute
    while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) throw new ResearchError('BIO_ACCESS_DENIED'); ancestor = parent }
    const offset = relative(base, realpathSync.native(ancestor))
    if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new ResearchError('BIO_ACCESS_DENIED')
    return absolute
  }
  private content(entry: ProjectionEntry, file: string): string {
    if (entry.format !== 'stored-snapshot' || !entry.header) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
    const payload = JSON.stringify({ format: 'stored-snapshot', header: entry.header, messages: entry.messages })
    if (createHash('sha256').update(payload).digest('hex') !== entry.hash) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
    const header = { ...entry.header, bioProjection: { operationId: entry.operationId, generation: entry.generation, hash: entry.hash } }
    return [header, ...entry.messages].map(value => makeSessionPathPortable(JSON.stringify(value), dirname(file))).join('\n') + '\n'
  }
  private sessionPath(path: string, root: string, sessionId: string): string {
    const absolute = this.checked(path), sessionDirectory = dirname(getSessionFilePath(root, sessionId))
    const inside = relative(sessionDirectory, absolute)
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new ResearchError('BIO_ACCESS_DENIED')
    // Namespace membership alone cannot authorize another workspace's data.
    // Below the trusted workspace root every existing component must resolve
    // to its expected location, including sessions/, session ID, files and tmp.
    let ancestor = absolute
    while (!existsSync(ancestor)) ancestor = dirname(ancestor)
    const expected = resolve(realpathSync.native(root), relative(root, ancestor))
    if (relative(expected, realpathSync.native(ancestor)) !== '') throw new ResearchError('BIO_ACCESS_DENIED')
    return absolute
  }
  private async project(actor: Actor, sessionId: string): Promise<void> {
    try {
      const entries = this.repository.readProjection(actor, sessionId, true), latest = entries.at(-1)
      if (!latest) return
      const root = this.checked(this.workspace(sessionId))
      if (!latest.header || typeof latest.header.workspaceRootPath !== 'string' || resolve(expandPath(latest.header.workspaceRootPath)) !== root) {
        throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
      }
      mkdirSync(root, { recursive: true }); this.checked(root)
      const file = this.sessionPath(getSessionFilePath(root, sessionId), root, sessionId)
      const directory = this.sessionPath(dirname(file), root, sessionId)
      mkdirSync(directory, { recursive: true }); this.sessionPath(directory, root, sessionId)
      const content = this.content(latest, file)
      const matches = (candidate: string) => {
        this.sessionPath(candidate, root, sessionId)
        return existsSync(candidate) && readFileSync(candidate, 'utf8') === content
      }
      const current = () => {
        this.sessionPath(directory, root, sessionId)
        this.sessionPath(file, root, sessionId)
        const now = this.repository.readProjection(actor, sessionId, true).at(-1)
        return now?.operationId === latest.operationId && now.generation === latest.generation && now.hash === latest.hash
      }
      if (!matches(file)) {
        const complete = readdirSync(directory).filter(name => name.startsWith('session.jsonl.tmp'))
          .map(name => join(directory, name)).find(matches)
        if (existsSync(file)) {
          // Preserve a formal file too when no journal snapshot recognizes it.
          const known = entries.filter(entry => entry.format === 'stored-snapshot').some(entry => readFileSync(file, 'utf8') === this.content(entry, file))
          if (!known) copyFileSync(file, join(directory, `session.jsonl.quarantine-${randomUUID()}`), constants.COPYFILE_EXCL)
        }
        if (complete) {
          const handle = await open(complete, 'r+'); try { await handle.sync() } finally { await handle.close() }
          if (!current()) throw new ResearchError('BIO_REVISION_CONFLICT')
          await rename(complete, file)
        } else await this.writer(file, content, current)
      }
      if (!matches(file) || !current()) throw new ResearchError('BIO_REVISION_CONFLICT')
      // Verify and sync bytes even after an interrupted replace that already put
      // the correct formal file in place but did not confirm the DB row.
      const handle = await open(file, 'r+'); try { await handle.sync() } finally { await handle.close() }
      this.repository.markProjected(actor, sessionId, latest.operationId, latest.generation, latest.hash)
    } catch (error) {
      if (error instanceof ResearchError) throw error
      throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
    }
  }
}
