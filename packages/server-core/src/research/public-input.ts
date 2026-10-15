import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ResearchError, parseContract, DeploymentModelConnectionSchema, PublicInputRequestSchema, PublicModelInputSchema, SessionSchema, SourceSchema, SnapshotSchema, sameScope,
  type Actor, type ResearchScope, type PublicModelInput } from '@bio-evidence/research-core'
import type { SqliteResearchRepository } from './sqlite-repository'
import { ArtifactsService } from './artifacts-service'
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }; return value }
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
export interface SelectedResearchConnection {
  readonly credentialId?: string
  readonly slug: string; readonly revision: number; readonly fingerprint: string; readonly api: 'openai-responses' | 'openai-completions'; readonly baseUrl: string;
  readonly model: { readonly id: string; readonly contextWindow: number; readonly maxOutputTokens: number }
}
export class ResearchConnectionBroker {
  constructor(private readonly repository: SqliteResearchRepository, private readonly readConnections: (actor: Actor, scope: ResearchScope) => unknown, private readonly readKey: (slug: string) => Promise<string | null>) {}
  private config(actor: Actor, scope: ResearchScope) {
    const parsed = parseContract(z.array(DeploymentModelConnectionSchema).max(1000), this.readConnections(actor, scope))
    if (new Set(parsed.map(item => item.slug)).size !== parsed.length) throw new ResearchError('BIO_CONNECTION_INVALID')
    return parsed
  }
  select(actor: Actor, scope: ResearchScope, id: string, modelId: string): SelectedResearchConnection {
    this.repository.authorizeScope(actor, scope, 'read')
    const connection = this.config(actor, scope).find(item => item.slug === id), model = connection?.models.find(item => item.id === modelId)
    if (!connection?.enabled || !model || !connection.scopes.some(item => sameScope(item, scope))) throw new ResearchError('BIO_CONNECTION_INVALID')
    let api: SelectedResearchConnection['api'], baseUrl: string
    if (connection.providerType === 'pi') {
      if (connection.piAuthProvider !== 'openai' || connection.baseUrl || connection.customEndpoint) throw new ResearchError('BIO_CONNECTION_INVALID')
      api = 'openai-responses'; baseUrl = 'https://api.openai.com/v1'
    } else {
      if (!connection.baseUrl || !connection.customEndpoint || connection.piAuthProvider) throw new ResearchError('BIO_CONNECTION_INVALID')
      const url = new URL(connection.baseUrl)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ResearchError('BIO_CONNECTION_INVALID')
      api = connection.customEndpoint.api; baseUrl = url.href.replace(/\/$/, '')
    }
    if (model.maxOutputTokens >= model.contextWindow) throw new ResearchError('BIO_CONNECTION_INVALID')
    return freeze({ slug: connection.slug, revision: connection.revision, fingerprint: hash(connection), api, baseUrl, model, ...(connection.credentialId ? { credentialId: connection.credentialId } : {}) })
  }
  async credentials(actor: Actor, scope: ResearchScope, selected: SelectedResearchConnection, assertCurrent: () => void) {
    const check = () => {
      assertCurrent()
      if (JSON.stringify(selected) !== JSON.stringify(this.select(actor, scope, selected.slug, selected.model.id))) throw new ResearchError('BIO_CONNECTION_INVALID')
    }
    check()
    let apiKey: string | null
    try { apiKey = await this.readKey(selected.credentialId ?? selected.slug) } catch { throw new ResearchError('BIO_CONNECTION_INVALID') }
    check()
    if (!apiKey || apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(apiKey)) throw new ResearchError('BIO_CONNECTION_INVALID')
    return { apiKey }
  }
}
export interface PreparedPublicInput {
  readonly manifest: { readonly id: string; readonly sessionId: string; readonly sessionRevision: number; readonly scope: ResearchScope; readonly actorId: string; readonly declaredAt: number; readonly policyVersion: 1; readonly contextHash: string; readonly connectionId: string; readonly model: string }
  readonly connection: SelectedResearchConnection; readonly modelInput: PublicModelInput; readonly assertCurrent: () => void
}
export class PublicInputService {
  constructor(private readonly repository: SqliteResearchRepository, private readonly broker: ResearchConnectionBroker, private readonly options: { currentActor?: (actor: Actor) => Actor; maxContextChars?: number } = {}) {}
  prepare(actor: Actor, raw: unknown): PreparedPublicInput {
    const request = freeze(parseContract(PublicInputRequestSchema, raw))
    const limit = this.options.maxContextChars ?? 32000
    if (!Number.isSafeInteger(limit) || limit < 1000 || limit > 32000) throw new ResearchError('BIO_MODEL_BUDGET')
    const build = () => {
      const current = this.options.currentActor?.(actor) ?? actor
      this.repository.authorizeResource(current, 'session', request.sessionId, 'execute')
      const session = parseContract(SessionSchema, this.repository.get(current, 'session', request.sessionId))
      if (session.policy !== 'public' || this.repository.hasUnclassifiedProjection(current, session.id)) throw new ResearchError('BIO_POLICY_DENIED')
      const connection = this.broker.select(current, session.scope, request.connectionId, request.model)
      const empty = JSON.stringify({ question: request.question, readingScope: 'selected-excerpts-only', blocks: [], evidence: [] })
      let chars = empty.length, bytes = Buffer.byteLength(empty)
      const assertBudget = () => {
        if (chars > limit || bytes + connection.model.maxOutputTokens + 2000 > connection.model.contextWindow) throw new ResearchError('BIO_MODEL_BUDGET')
      }
      const append = (value: unknown, count: number) => {
        const encoded = JSON.stringify(value), comma = count > 0 ? 1 : 0
        chars += encoded.length + comma; bytes += Buffer.byteLength(encoded) + comma
        assertBudget()
      }
      assertBudget()
      // Retain hashes, not every source/evidence payload, while checking current authority.
      const proof: string[] = [hash(session)], selectedFamilies = new Set<string>()
      for (const id of session.selectedSourceIds ?? []) {
        const source = parseContract(SourceSchema, this.repository.get(current, 'source', id)), head = this.repository.sourceHeadForRecord(current, id)
        if (source.policy !== 'public' || head.policy !== 'public' || !sameScope(source.scope, session.scope)) throw new ResearchError('BIO_POLICY_DENIED')
        selectedFamilies.add(source.sourceIdentityId ?? source.id); proof.push(hash(source), hash(head))
      }
      const blocks: PublicModelInput['blocks'] = [], seen = new Set<string>()
      for (const ref of request.blocks) {
        const snapshot = parseContract(SnapshotSchema, this.repository.get(current, 'snapshot', ref.snapshotId)), source = parseContract(SourceSchema, this.repository.get(current, 'source', snapshot.sourceId)), head = this.repository.sourceHeadForRecord(current, source.id)
        if (!sameScope(snapshot.scope, session.scope) || !selectedFamilies.has(source.sourceIdentityId ?? source.id)) throw new ResearchError('BIO_ACCESS_DENIED')
        if (snapshot.policy !== 'public' || source.policy !== 'public' || head.policy !== 'public') throw new ResearchError('BIO_POLICY_DENIED')
        const block = snapshot.blocks.find(block => block.id === ref.blockId), key = `${ref.snapshotId}:${ref.blockId}:${ref.start}:${ref.end}`
        if (!block || ref.end > block.text.length || seen.has(key)) throw new ResearchError('BIO_INPUT_INVALID')
        if (ref.end - ref.start > limit - chars) throw new ResearchError('BIO_MODEL_BUDGET')
        const selected = { ...ref, sourceId: source.id, text: block.text.slice(ref.start, ref.end), locator: block.locator, coverage: snapshot.coverage.level, totalUnits: snapshot.coverage.totalUnits, selectedUnit: block.unit,
          ...(source.title ? { sourceTitle: source.title } : {}), identifiers: source.identifiers, metadataPending: !!((source.metadataConflictFields?.length && !source.metadataReview) || (head.metadataConflictFields?.length && !head.metadataReview)), contentHash: snapshot.contentHash }
        append(selected, blocks.length)
        blocks.push(selected); seen.add(key); proof.push(snapshot.id, snapshot.contentHash, hash(source), hash(head))
      }
      const evidence: PublicModelInput['evidence'] = [], artifacts = new ArtifactsService(this.repository)
      for (const id of request.evidenceRevisionIds) {
        const view = artifacts.evidenceView(current, id), item = view.revision
        if (!sameScope(item.scope, session.scope) || item.sessionId !== session.id) throw new ResearchError('BIO_ACCESS_DENIED')
        if (view.effectivePolicy !== 'public') throw new ResearchError('BIO_POLICY_DENIED')
        if (item.citations.some(ref => !blocks.some(block => block.snapshotId === ref.snapshotId && block.blockId === ref.blockId && block.start <= ref.start && block.end >= ref.end))) throw new ResearchError('BIO_INPUT_INVALID')
        const selected = { id: item.id, claim: item.claim, factSummary: item.factSummary ?? '', limitations: item.limitations ?? '', missingInformation: item.missingInformation ?? [], citations: item.citations, structuralStatus: item.structuralStatus }
        append(selected, evidence.length)
        evidence.push(selected); proof.push(hash(item))
      }
      const modelInput = parseContract(PublicModelInputSchema, { question: request.question, readingScope: 'selected-excerpts-only', blocks, evidence })
      return { current, session, modelInput, connection, proofHash: hash(proof) }
    }
    const initial = build(), modelInput = freeze(initial.modelInput), connection = initial.connection
    return Object.freeze({ manifest: freeze({ id: randomUUID(), sessionId: initial.session.id, sessionRevision: initial.session.revision, scope: initial.session.scope,
      actorId: initial.current.userId, declaredAt: Date.now(), policyVersion: 1 as const, contextHash: hash(modelInput), connectionId: connection.slug, model: connection.model.id }), modelInput, connection,
      assertCurrent: () => { const next = build(); if (next.proofHash !== initial.proofHash || hash(next.modelInput) !== hash(modelInput) || JSON.stringify(next.connection) !== JSON.stringify(connection)) throw new ResearchError('BIO_REVISION_CONFLICT') } })
  }
}
