import { replaceFileDurably } from './atomic-file.js'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
  generation: number
  epoch: number
}

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * Debounce and explicit flush use the same per-session writer. Flush observes
 * consumed pending entries too, and errors remain observable until a new enqueue.
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private inFlightSignature = new Map<string, string>()
  private generation = new Map<string, number>()
  private committed = new Map<string, number>()
  private epoch = new Map<string, number>()
  private failures = new Map<string, Error>()
  private blocked = new Set<string>()
  private debounceMs: number

  constructor(debounceMs = 500, private readonly writer?: (file: string, content: string, current: () => boolean) => Promise<void>) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    if (this.blocked.has(session.id)) throw new Error('SESSION_WRITE_CANCELLED')
    const data = structuredClone(session)
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const generation = (this.generation.get(session.id) ?? 0) + 1
    this.generation.set(session.id, generation)
    this.failures.delete(session.id)
    const timer = setTimeout(() => {
      void this.start(session.id).catch(() => { console.error('[PersistenceQueue] SESSION_PERSISTENCE_FAILED') })
    }, this.debounceMs)
    this.pending.set(session.id, { data, timer, generation, epoch: this.epoch.get(session.id) ?? 0 })
  }

  private start(sessionId: string): Promise<void> {
    const existing = this.writeInProgress.get(sessionId)
    if (existing) return existing
    // Deferring the drain by one microtask lets all entry points install and
    // share this same promise before any synchronous prepare code runs.
    const work = Promise.resolve().then(async () => {
      while (this.pending.has(sessionId)) {
        const entry = this.pending.get(sessionId)!
        clearTimeout(entry.timer)
        this.pending.delete(sessionId)
        try {
          await this.write(sessionId, entry)
          if ((this.epoch.get(sessionId) ?? 0) === entry.epoch) this.committed.set(sessionId, entry.generation)
        } catch {
          if ((this.epoch.get(sessionId) ?? 0) !== entry.epoch) continue
          const error = new Error('SESSION_PERSISTENCE_FAILED')
          this.failures.set(sessionId, error)
          throw error
        }
      }
    }).finally(() => { this.writeInProgress.delete(sessionId) })
    this.writeInProgress.set(sessionId, work)
    return work
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(sessionId: string, entry: PendingWrite): Promise<void> {
      const { data } = entry
      ensureSessionsDir(data.workspaceRootPath)
      ensureSessionDir(data.workspaceRootPath, sessionId)

      const filePath = getSessionFilePath(data.workspaceRootPath, sessionId)

      // Prepare session with portable paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
        lastUsedAt: Date.now(),
      }

      // Create JSONL content: header + messages (one per line)
      // SessionManager already selects persistable messages before enqueue.
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)
      const lines = [
        makeSessionPathPortable(JSON.stringify(header), sessionDir),
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ]

      // Atomic write: write to .tmp then rename over the real file.
      // If the process crashes mid-write, only the .tmp is corrupted —
      // the original session.jsonl remains intact.
      //
      // Update signature BEFORE the write so that fs.watch events fired
      // during rename are correctly identified as self-writes. A separate
      // in-flight signature is cleared on failure; committed state stays intact.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions.
      const finalSignature = getHeaderMetadataSignature(header)
      this.inFlightSignature.set(sessionId, finalSignature)
      try {
        await (this.writer ?? replaceFileDurably)(filePath, lines.join('\n') + '\n',
          () => !this.blocked.has(sessionId) && (this.epoch.get(sessionId) ?? 0) === entry.epoch)
        if ((this.epoch.get(sessionId) ?? 0) === entry.epoch) this.lastWrittenHeaderSignature.set(sessionId, finalSignature)
      } finally { this.inFlightSignature.delete(sessionId) }
  }

  /**
   * Observe persistence of the requested generation and any active writer,
   * including a debounce write that has already consumed the pending entry.
   */
  async flush(sessionId: string): Promise<void> {
    const target = this.generation.get(sessionId) ?? 0
    const epoch = this.epoch.get(sessionId) ?? 0
    const assertCurrent = () => {
      if ((this.epoch.get(sessionId) ?? 0) !== epoch) throw new Error('SESSION_WRITE_CANCELLED')
    }
    while ((this.committed.get(sessionId) ?? 0) < target) {
      assertCurrent()
      const failure = this.failures.get(sessionId)
      if (failure) throw failure
      if (!this.pending.has(sessionId) && !this.writeInProgress.has(sessionId)) throw new Error('SESSION_WRITE_CANCELLED')
      await this.start(sessionId)
      assertCurrent()
    }
    // An active write for a newer generation must also be observed.
    const active = this.writeInProgress.get(sessionId)
    if (active) await active
    assertCurrent()
  }

  /**
   * Discard queued data and invalidate an active generation. A watcher may
   * enqueue a replacement; use discardAndWait before deleting the directory.
   */
  cancel(sessionId: string): void {
    this.epoch.set(sessionId, (this.epoch.get(sessionId) ?? 0) + 1)
    this.failures.delete(sessionId)
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    this.lastWrittenHeaderSignature.delete(sessionId)
  }

  /** Block new enqueue calls and settle the old writer before directory deletion. */
  async discardAndWait(sessionId: string): Promise<void> {
    this.blocked.add(sessionId)
    this.cancel(sessionId)
    await this.writeInProgress.get(sessionId)?.catch(() => {})
    this.cancel(sessionId)
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const sessionIds = new Set([...this.pending.keys(), ...this.writeInProgress.keys(), ...this.failures.keys()])
    const outcomes = await Promise.allSettled([...sessionIds].map(id => this.flush(id)))
    if (outcomes.some(result => result.status === 'rejected')) throw new Error('SESSION_PERSISTENCE_FAILED')
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId) || this.writeInProgress.has(sessionId) || this.failures.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.inFlightSignature.get(sessionId) ?? this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return new Set([...this.pending.keys(), ...this.writeInProgress.keys(), ...this.failures.keys()]).size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
