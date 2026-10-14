import { createHash, randomUUID } from 'node:crypto'
import { ResearchError, SessionSchema, SourceSchema, SnapshotSchema, LiteratureRecordSchema, LiteratureCandidateSchema,
  LiteratureSearchPageSchema, canonicalIdentifiers, parseContract, parseResearchRequest, RESEARCH_CHANNELS as R,
  sameScope, ParsedDocumentSchema, type ParsedDocumentResult, type Actor, type LiteratureCandidate, type LiteratureSearchPage, type LiteratureSelection, type ResearchSource,
} from '@bio-evidence/research-core'
import type { SqliteResearchRepository } from './sqlite-repository'
import { LiteratureProviderError, type LiteratureProvider } from './literature-provider'
const TTL = 15 * 60 * 1000
const metadataKeys = ['title', 'authors', 'year', 'abstract', 'identifiers', 'license', 'provider'] as const
type SearchInput = { sessionId: string; query: string; cursor?: string; pageSize?: number }
type Ticket = { candidate: LiteratureCandidate; actorId: string; authSessionId: string; expires: number; bytes: number }
export class LiteratureService {
  // Server-only ingestion seam: the upload/parser stage supplies bytes; no path/URL or client policy is accepted.
  registerPdf(actor: Actor, input: { sessionId: string; expectedRevision: number; bytes: Uint8Array; declaredPublic?: boolean }, parsed?: Extract<ParsedDocumentResult, { status: 'ok' }>) {
    actor = this.current(actor)
    this.repository.authorizeResource(actor, 'session', input.sessionId, 'execute')
    const session = parseContract(SessionSchema, this.repository.get(actor, 'session', input.sessionId))
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > 25 * 1024 * 1024 ||
      (input.declaredPublic !== undefined && typeof input.declaredPublic !== 'boolean')) throw new ResearchError('BIO_INPUT_INVALID')
    const contentHash = createHash('sha256').update(input.bytes).digest('hex'), now = this.now()
    const candidates = this.repository.sourceHeads(actor, session.scope).filter(source => source.provider === 'pdf-import' && source.contentHash === contentHash)
    const existingPrivate = candidates.some(source => source.policy !== 'public')
    if (existingPrivate && input.declaredPublic) throw new ResearchError('BIO_POLICY_DENIED')
    const existing = candidates.find(source => source.policy === (input.declaredPublic ? 'public' : 'restricted'))
    const source = existing ?? parseContract(SourceSchema, { id: randomUUID(), sourceIdentityId: randomUUID(), revision: 1, scope: session.scope,
      provider: 'pdf-import', policy: input.declaredPublic ? 'public' : 'restricted', license: { status: 'unknown' }, identifiers: {}, contentHash, createdAt: now,
      ...(input.declaredPublic ? { declaration: { actorId: actor.userId, declaredAt: now, kind: 'explicit-public-pdf' } } : {}) })
    let snapshot: ReturnType<typeof SnapshotSchema.parse> | undefined
    if (parsed) {
      const content = parseContract(ParsedDocumentSchema, parsed)
      if (content.format !== 'pdf') throw new ResearchError('BIO_INPUT_INVALID')
      snapshot = parseContract(SnapshotSchema, { id: randomUUID(), sourceId: source.id, scope: source.scope, policy: source.policy, license: source.license,
        contentHash, retrievedAt: now, acquiredBy: source.policy === 'public' ? 'declared-public-pdf' : 'private-pdf', format: content.format, coverage: content.coverage, blocks: content.blocks })
    }
    const updated = this.repository.commitSourceSelection(actor, session.id, input.expectedRevision, source, !existing, snapshot)
    return { status: 'selected' as const, source, session: updated, created: !existing, ...(snapshot ? { snapshot } : {}) }
  }
  copySource(actor: Actor, input: { sessionId: string; expectedRevision: number; sourceId: string }) {
    actor = this.current(actor)
    this.repository.authorizeResource(actor, 'session', input.sessionId, 'execute')
    const session = parseContract(SessionSchema, this.repository.get(actor, 'session', input.sessionId))
    const original = parseContract(SourceSchema, this.repository.get(actor, 'source', input.sourceId))
    if (!sameScope(session.scope, original.scope)) throw new ResearchError('BIO_ACCESS_DENIED')
    const updated = this.repository.commitSourceSelection(actor, session.id, input.expectedRevision, original, false)
    return { status: 'selected' as const, source: original, session: updated, created: false }
  }
  async openText(actor: Actor, sourceId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const read = () => {
      const source = parseContract(SourceSchema, this.repository.get(this.current(actor), 'source', sourceId))
      if (source.policy !== 'public' || source.provider !== 'europe-pmc' || !source.availability?.fullText || !source.identifiers.pmcid) throw new ResearchError('BIO_POLICY_DENIED')
      return source
    }
    const source = read()
    try { const bytes = await this.provider.openText({ pmcid: source.identifiers.pmcid!, signal }); read(); return bytes }
    catch (error) { throw providerError(error) }
  }
  private cache = new Map<string, { records: Awaited<ReturnType<LiteratureProvider['search']>>; retrievedAt: number; bytes: number }>()
  private tickets = new Map<string, Ticket>()
  private readonly now: () => number
  constructor(private readonly repository: SqliteResearchRepository, private readonly provider: LiteratureProvider,
    private readonly options: { now?: () => number; currentActor?: (actor: Actor) => Actor } = {}) { this.now = options.now ?? Date.now }
  private current(actor: Actor): Actor { return this.options.currentActor?.(actor) ?? actor }
  assertPublicSession(actor: Actor, sessionId: string) {
    actor = this.current(actor)
    this.repository.authorizeResource(actor, 'session', sessionId, 'execute')
    const session = parseContract(SessionSchema, this.repository.get(actor, 'session', sessionId))
    if (session.policy !== 'public') throw new ResearchError('BIO_POLICY_DENIED')
    return session
  }
  private prune() {
    const now = this.now()
    for (const [key, value] of this.cache) if (now - value.retrievedAt >= TTL) this.cache.delete(key)
    for (const [key, value] of this.tickets) if (now >= value.expires) this.tickets.delete(key)
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!)
    while (this.tickets.size > 5000) this.tickets.delete(this.tickets.keys().next().value!)
    for (const map of [this.cache, this.tickets]) {
      let bytes = [...map.values()].reduce((sum, value) => sum + value.bytes, 0)
      while (bytes > 16 * 1024 * 1024) {
        const [key, value] = map.entries().next().value!; bytes -= value.bytes; map.delete(key)
      }
    }
  }
  async search(actor: Actor, raw: SearchInput): Promise<LiteratureSearchPage> {
    const input = parseResearchRequest(R.SEARCH, raw), session = this.assertPublicSession(actor, input.sessionId)
    this.prune()
    const key = JSON.stringify([session.scope, session.policy, input.query, input.cursor, input.pageSize])
    let cached = this.cache.get(key)
    if (!cached) {
      try {
        const result = await this.provider.search(input)
        const records = { items: result.items.map(item => parseContract(LiteratureRecordSchema, item)), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }
        if (records.items.length > input.pageSize || (records.nextCursor?.length ?? 0) > 2000) throw new ResearchError('BIO_PROVIDER_UNAVAILABLE')
        this.assertPublicSession(actor, input.sessionId)
        const bytes = Buffer.byteLength(JSON.stringify(records))
        if (bytes > 10 * 1024 * 1024) throw new ResearchError('BIO_PROVIDER_BUDGET')
        cached = { records, retrievedAt: this.now(), bytes }; this.cache.set(key, cached)
      } catch (error) { throw providerError(error) }
    }
    this.assertPublicSession(actor, input.sessionId)
    const items = cached.records.items.map(item => {
      const candidate = parseContract(LiteratureCandidateSchema, { ...item, identifiers: canonicalIdentifiers({ ...item.identifiers, providerId: item.providerId }), id: randomUUID(), sessionId: session.id, retrievedAt: cached!.retrievedAt })
      this.tickets.set(candidate.id, { candidate: structuredClone(candidate), actorId: actor.userId, authSessionId: actor.authSessionId, expires: cached!.retrievedAt + TTL, bytes: Buffer.byteLength(JSON.stringify(candidate)) })
      return candidate
    })
    this.prune()
    return { items, ...(cached.records.nextCursor ? { nextCursor: cached.records.nextCursor } : {}) }
  }
  private ticket(actor: Actor, sessionId: string, candidateId: string): LiteratureCandidate {
    this.assertPublicSession(actor, sessionId)
    const ticket = this.tickets.get(candidateId)
    if (!ticket || ticket.expires <= this.now() || ticket.actorId !== actor.userId || ticket.authSessionId !== actor.authSessionId || ticket.candidate.sessionId !== sessionId) throw new ResearchError('BIO_ACCESS_DENIED')
    return ticket.candidate
  }
  validateSearch(actor: Actor, input: SearchInput, result: unknown): void {
    const page = parseContract(LiteratureSearchPageSchema, result)
    this.assertPublicSession(actor, input.sessionId)
    if (page.items.length > (input.pageSize ?? 25)) throw new ResearchError('BIO_ACCESS_DENIED')
    for (const candidate of page.items) if (JSON.stringify(this.ticket(actor, input.sessionId, candidate.id)) !== JSON.stringify(candidate)) throw new ResearchError('BIO_ACCESS_DENIED')
  }
  select(actor: Actor, input: { sessionId: string; candidateId: string; expectedRevision: number }): LiteratureSelection {
    const candidate = this.ticket(actor, input.sessionId, input.candidateId), session = this.assertPublicSession(actor, input.sessionId)
    if (session.revision !== input.expectedRevision) throw new ResearchError('BIO_REVISION_CONFLICT')
    actor = this.current(actor)
    const matches = this.repository.sourceHeads(actor, session.scope).filter(source => source.policy === 'public' &&
      Object.entries(candidate.identifiers).some(([key, value]) => value && canonicalIdentifiers(source.identifiers)[key as keyof ResearchSource['identifiers']] === value))
    if (matches.length > 1) return { status: 'identity-conflict', candidates: matches.slice(0, 100) }
    const old = matches[0], now = this.now()
    const identifiers = { ...old?.identifiers, ...candidate.identifiers }
    const conflicts = old ? metadataKeys.filter(key => old[key] !== undefined && candidate[key] !== undefined && JSON.stringify(old[key]) !== JSON.stringify(candidate[key])) : []
    const metadata = { provider: candidate.provider, identifiers, license: candidate.license,
      ...Object.fromEntries(['title', 'authors', 'year', 'abstract'].flatMap(key => {
        const value = candidate[key as keyof LiteratureCandidate]
        return value === undefined ? [] : [[key, value]]
      })), availability: candidate.availability }
    const changed = !old || [...metadataKeys, 'availability' as const].some(key => JSON.stringify(old[key]) !== JSON.stringify(metadata[key as keyof typeof metadata]))
    const source = changed ? parseContract(SourceSchema, { ...metadata, id: randomUUID(), scope: session.scope, policy: 'public',
      sourceIdentityId: old?.sourceIdentityId ?? old?.id ?? randomUUID(), revision: (old?.revision ?? (old ? 1 : 0)) + 1,
      ...(old ? { predecessorId: old.id } : {}), createdAt: now, retrievedAt: candidate.retrievedAt,
      declaration: { actorId: actor.userId, declaredAt: now, kind: 'public-provider' }, metadataConflictFields: conflicts }) : old!
    const existing = changed ? undefined : this.repository.abstractSnapshot(actor, source.id)
    const text = source.abstract
    const snapshot = existing ?? (text?.trim() ? parseContract(SnapshotSchema, { id: randomUUID(), sourceId: source.id, scope: source.scope, policy: 'public', license: source.license,
      format: 'abstract', acquiredBy: 'europe-pmc-abstract', retrievedAt: candidate.retrievedAt,
      contentHash: createHash('sha256').update(text).digest('hex'), coverage: { level: 'abstract', totalUnits: 1, units: [{ unit: 1, status: 'read' }] },
      blocks: Array.from({ length: Math.ceil(text.length / 200000) }, (_, index) => ({ id: randomUUID(), unit: 1, text: text.slice(index * 200000, (index + 1) * 200000), locator: { kind: 'abstract' } })) }) : undefined)
    const updated = this.repository.commitSourceSelection(actor, session.id, input.expectedRevision, source, changed, existing ? undefined : snapshot)
    return { status: 'selected', source, session: updated, ...(snapshot ? { snapshot } : {}), created: changed }
  }
}
function providerError(error: unknown): ResearchError {
  if (error instanceof ResearchError) return error
  if (error instanceof LiteratureProviderError) {
    if (error.reason === 'rate-limited') return new ResearchError('BIO_PROVIDER_RATE_LIMITED')
    if (error.reason === 'timeout') return new ResearchError('BIO_PROVIDER_TIMEOUT')
    if (error.reason === 'budget') return new ResearchError('BIO_PROVIDER_BUDGET')
    if (error.reason === 'invalid') return new ResearchError('BIO_INPUT_INVALID')
  }
  return new ResearchError('BIO_PROVIDER_UNAVAILABLE')
}
