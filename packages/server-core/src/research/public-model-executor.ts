import { ResearchError, PublicEvidenceCandidateSchema, PublicReportCandidateSchema, PublicCandidateResultSchema, parseContract, IdSchema,
  type Actor, type PublicCandidateResult } from '@bio-evidence/research-core'
import { createBackend } from '@craft-agent/shared/agent/backend/factory'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace.mjs'
import type { PublicResearchRuntime } from '@craft-agent/shared/agent/backend/public-research'
import type { SqliteResearchRepository } from './sqlite-repository'
import type { PreparedPublicInput, PublicInputService, ResearchConnectionBroker } from './public-input'
import type { PublicModelWorkerService } from './public-model-worker'
export function validatePublicCandidate(prepared: PreparedPublicInput, purpose: 'evidence' | 'report', text: string): PublicCandidateResult {
  if (Buffer.byteLength(text) > 262144) throw new ResearchError('BIO_MODEL_BUDGET')
  let raw: unknown; try { raw = JSON.parse(text) } catch { throw new ResearchError('BIO_INPUT_INVALID') }
  if (purpose === 'evidence') {
    const content = parseContract(PublicEvidenceCandidateSchema, raw)
    let pending = false
    for (const ref of content.citations) {
      const block = prepared.modelInput.blocks.find(block => block.snapshotId === ref.snapshotId && block.blockId === ref.blockId && block.start <= ref.start && block.end >= ref.end)
      if (!block) throw new ResearchError('BIO_INPUT_INVALID')
      if (block.text.slice(ref.start - block.start, ref.end - block.start) !== ref.quote || block.metadataPending) pending = true
    }
    return parseContract(PublicCandidateResultSchema, { kind: 'evidence', content, structuralStatus: pending ? 'pending' : 'structure-valid', reviewStatus: 'unreviewed' })
  }
  const content = parseContract(PublicReportCandidateSchema, raw), evidence = prepared.modelInput.evidence
  if (new Set(content.claims.map(claim => claim.id)).size !== content.claims.length || content.claims.some(claim => claim.evidenceRevisionIds.some(id => !evidence.some(item => item.id === id)))) throw new ResearchError('BIO_INPUT_INVALID')
  const pending = content.claims.some(claim => !claim.evidenceRevisionIds.length || claim.evidenceRevisionIds.some(id => evidence.find(item => item.id === id)!.structuralStatus !== 'structure-valid')) || prepared.modelInput.blocks.some(block => block.metadataPending)
  return parseContract(PublicCandidateResultSchema, { kind: 'report', content, structuralStatus: pending ? 'pending' : 'structure-valid', reviewStatus: 'unreviewed' })
}
export class PublicModelExecutor {
  constructor(private readonly repository: SqliteResearchRepository, private readonly inputs: PublicInputService, private readonly broker: ResearchConnectionBroker, private readonly worker: Pick<PublicModelWorkerService, 'run'>) {}
  async generate(actor: Actor, raw: unknown, purpose: 'evidence' | 'report', signal?: AbortSignal): Promise<PublicCandidateResult> {
    const sessionId = parseContract(IdSchema, raw && typeof raw === 'object' ? (raw as Record<string, unknown>).sessionId : undefined)
    let backend: ReturnType<typeof createBackend> | undefined
    try {
      const prepared = this.inputs.prepare(actor, raw), controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      let result: PublicCandidateResult | undefined, used = false
      const worker = this.worker, broker = this.broker
      const runtime: PublicResearchRuntime = { model: prepared.connection.model.id, connectionId: prepared.connection.slug, approvedInput: prepared.manifest.id, assertCurrent: prepared.assertCurrent, abort: async () => { controller.abort() }, stream: async function* () {
        if (used || combined.aborted) throw new ResearchError('BIO_MODEL_UNAVAILABLE'); used = true
        prepared.assertCurrent()
        const { apiKey } = await broker.credentials(actor, prepared.manifest.scope, prepared.connection, prepared.assertCurrent)
        const text = await worker.run(prepared, purpose, apiKey, combined)
        prepared.assertCurrent(); result = validatePublicCandidate(prepared, purpose, text)
        yield { type: 'text_complete', text: JSON.stringify(result) }; yield { type: 'complete' }
      } }
      backend = createBackend({ provider: 'pi', model: runtime.model, connectionSlug: runtime.connectionId, executionProfile: 'public-research', publicResearchRuntime: runtime,
        workspace: { id: 'public-research', name: 'Public research', slug: 'public-research', rootPath: resolveConfigDir(), createdAt: 0 }, isHeadless: true, skipConfigWatcher: true })
      this.repository.recordPublicModelOutcome(actor, sessionId, purpose, 'started', 'success')
      for await (const _ of backend.chat(runtime.approvedInput)) {}
      prepared.assertCurrent()
      if (!result) throw new ResearchError('BIO_MODEL_UNAVAILABLE')
      this.repository.recordPublicModelOutcome(actor, sessionId, purpose, 'finished', 'success')
      return result
    } catch (error) {
      this.repository.recordPublicModelOutcome(actor, sessionId, purpose, 'finished', 'failed')
      if (error instanceof ResearchError) throw error
      throw new ResearchError('BIO_MODEL_UNAVAILABLE')
    } finally { backend?.destroy() }
  }
}
