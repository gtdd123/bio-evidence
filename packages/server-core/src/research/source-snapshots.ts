import { createHash, randomUUID } from 'node:crypto'
import { ResearchError, SessionSchema, SourceSchema, SnapshotSchema, parseContract, sameScope,
  DocumentIngestResultSchema, type Actor, type DocumentIngestResult, type ResearchSession } from '@bio-evidence/research-core'
import type { SqliteResearchRepository } from './sqlite-repository'
import type { LiteratureService } from './literature-service'
import type { DocumentParseService } from './document-parse'
import type { MaterialsService } from './materials-service'
export class SourceSnapshotService {
  private closed = false
  private controllers = new Set<AbortController>()
  private pending = new Set<Promise<DocumentIngestResult>>()
  constructor(private readonly repository: SqliteResearchRepository, private readonly literature: LiteratureService, private readonly parser: DocumentParseService,
    private readonly options: { materials?: MaterialsService; currentActor?: (actor: Actor) => Actor } = {}) {}
  private current(actor: Actor) { return this.options.currentActor?.(actor) ?? actor }
  list(actor: Actor, sourceId: string, pageSize: number, cursor?: string) { return this.repository.listSourceSnapshots(this.current(actor), sourceId, pageSize, cursor) }
  authorizeSession(actor: Actor, sessionId: string) { return this.session(actor, sessionId) }
  get limits() { return this.parser.limits }
  validateResult(actor: Actor, sessionId: string, raw: unknown): void {
    const result = parseContract(DocumentIngestResultSchema, raw), session = this.session(actor, sessionId)
    if (result.status !== 'ok') return
    if (result.session.id !== sessionId || JSON.stringify(result.session) !== JSON.stringify(session) || !session.selectedSourceIds?.includes(result.source.id) ||
      !sameScope(session.scope, result.source.scope) || result.snapshot.sourceId !== result.source.id ||
      JSON.stringify(result.source) !== JSON.stringify(this.repository.get(this.current(actor), 'source', result.source.id)) ||
      JSON.stringify(result.snapshot) !== JSON.stringify(this.repository.get(this.current(actor), 'snapshot', result.snapshot.id))) throw new ResearchError('BIO_ACCESS_DENIED')
  }
  private session(actor: Actor, sessionId: string, expectedRevision?: number): ResearchSession {
    actor = this.current(actor); this.repository.authorizeResource(actor, 'session', sessionId, 'execute')
    const session = parseContract(SessionSchema, this.repository.get(actor, 'session', sessionId))
    if (expectedRevision !== undefined && session.revision !== expectedRevision) throw new ResearchError('BIO_REVISION_CONFLICT')
    return session
  }
  private async task(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<DocumentIngestResult>): Promise<DocumentIngestResult> {
    if (this.closed) return { status: 'unavailable' }
    if (this.controllers.size) return { status: 'busy' }
    const controller = new AbortController(); this.controllers.add(controller)
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    let pending: Promise<DocumentIngestResult> | undefined
    try { if (combined.aborted) return { status: 'cancelled' }; pending = work(combined); this.pending.add(pending); return await pending }
    finally { this.controllers.delete(controller); if (pending) this.pending.delete(pending) }
  }
  async importPdf(actor: Actor, input: { sessionId: string; expectedRevision: number; bytes: Uint8Array; declaredPublic?: boolean }, signal?: AbortSignal): Promise<DocumentIngestResult> {
    this.session(actor, input.sessionId, input.expectedRevision)
    if (!(input.bytes instanceof Uint8Array)) throw new ResearchError('BIO_INPUT_INVALID')
    if (input.bytes.length > this.parser.limits.pdfMaxBytes) return { status: 'budget' }
    return this.task(signal, async currentSignal => {
      const captured = { ...input, bytes: Uint8Array.from(input.bytes) }
      const parsed = await this.parser.parse(captured.bytes, 'pdf', currentSignal)
      this.session(actor, captured.sessionId, captured.expectedRevision)
      if (currentSignal.aborted) return { status: 'cancelled' }
      if (parsed.status !== 'ok') return parsed
      const result = this.literature.registerPdf(this.current(actor), captured, parsed)
      if (!result.snapshot) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
      return { status: 'ok', source: result.source, session: result.session, snapshot: result.snapshot }
    })
  }
  async readOpenText(actor: Actor, input: { sessionId: string; sourceId: string }, signal?: AbortSignal): Promise<DocumentIngestResult> {
    const assertSelected = () => {
      const session = this.literature.assertPublicSession(this.current(actor), input.sessionId)
      const source = parseContract(SourceSchema, this.repository.get(this.current(actor), 'source', input.sourceId))
      if (!session.selectedSourceIds?.includes(source.id) || !sameScope(session.scope, source.scope)) throw new ResearchError('BIO_ACCESS_DENIED')
      return { source, session }
    }
    assertSelected()
    return this.task(signal, async currentSignal => {
      const bytes = await this.literature.openText(this.current(actor), input.sourceId, currentSignal), retrievedAt = Date.now()
      assertSelected()
      const parsed = await this.parser.parse(bytes, 'jats', currentSignal), { source, session } = assertSelected()
      if (currentSignal.aborted) return { status: 'cancelled' }
      if (parsed.status !== 'ok') return parsed
      const snapshot = parseContract(SnapshotSchema, { id: randomUUID(), sourceId: source.id, scope: source.scope, policy: 'public', license: source.license,
        contentHash: createHash('sha256').update(bytes).digest('hex'), retrievedAt, acquiredBy: 'europe-pmc-oa', format: parsed.format, coverage: parsed.coverage, blocks: parsed.blocks })
      this.repository.put(this.current(actor), 'snapshot', snapshot)
      return { status: 'ok', source, session, snapshot }
    })
  }
  async importMaterialPdf(actor: Actor, input: { sessionId: string; expectedRevision: number; rootId: string; relativeDir: string; generation: number; fileId: string }, signal?: AbortSignal): Promise<DocumentIngestResult> {
    const materials = this.options.materials
    if (!materials) throw new ResearchError('BIO_ACCESS_DENIED')
    const check = () => {
      const session = this.session(actor, input.sessionId, input.expectedRevision), root = materials.getRoot(this.current(actor), input.rootId)
      if (!sameScope(root.scope, session.scope)) throw new ResearchError('BIO_ACCESS_DENIED')
      return materials.fileEntry(this.current(actor), input.rootId, input.relativeDir, input.generation, input.fileId)
    }
    const entry = check()
    if (entry.size > this.parser.limits.pdfMaxBytes) return { status: 'budget' }
    return this.task(signal, async currentSignal => {
      const file = await materials.openFile(this.current(actor), input.rootId, input.relativeDir, input.generation, input.fileId), chunks: Uint8Array[] = []; let size = 0
      try {
        for await (const chunk of file.chunks(currentSignal)) {
          check(); size += chunk.length
          if (size > this.parser.limits.pdfMaxBytes) return { status: 'budget' }
          chunks.push(chunk)
        }
      } finally { await file.close() }
      const bytes = Buffer.concat(chunks), parsed = await this.parser.parse(bytes, 'pdf', currentSignal)
      check()
      if (currentSignal.aborted) return { status: 'cancelled' }
      if (parsed.status !== 'ok') return parsed
      const result = this.literature.registerPdf(this.current(actor), { sessionId: input.sessionId, expectedRevision: input.expectedRevision, bytes }, parsed)
      if (!result.snapshot) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
      return { status: 'ok', source: result.source, session: result.session, snapshot: result.snapshot }
    })
  }
  async close(): Promise<void> {
    this.closed = true; for (const controller of this.controllers) controller.abort()
    await this.parser.close(); await Promise.allSettled([...this.pending])
  }
}
