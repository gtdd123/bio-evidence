import { randomUUID } from 'node:crypto'
import { ResearchError, StartResearchRunSchema, PublicInputRequestSchema, SessionSchema, parseContract, type Actor, type JsonValue } from '@bio-evidence/research-core'
import type { StoredSession } from '@craft-agent/shared/sessions'
import type { SqliteResearchRepository } from './sqlite-repository'
import type { PublicInputService, PreparedPublicInput } from './public-input'
import type { PublicModelExecutor } from './public-model-executor'
import type { ArtifactsService } from './artifacts-service'
import { validatePublicCandidate } from './public-model-executor'

export interface ResearchSessionProjection {
  researchSessionSnapshot(session: StoredSession): { header: { [key: string]: JsonValue }; messages: JsonValue[] }
  reconcileResearchSession(actor: Actor, id: string): Promise<void>
}
interface QueuedRun { prepared: PreparedPublicInput; controller: AbortController }
/** A single owned execution queue. Clients can observe it without owning its lifetime. */
export class ResearchRunService {
  private readonly queue = new Map<string, QueuedRun>()
  private working: Promise<void> | undefined
  private closed = false
  private projectionCursor = ''
  private recovering: Promise<void> | undefined
  constructor(private readonly repository: SqliteResearchRepository, private readonly inputs: PublicInputService,
    private readonly executor: Pick<PublicModelExecutor, 'generatePrepared'>, private readonly artifacts: ArtifactsService,
    private readonly sessions: ResearchSessionProjection, private readonly workspace: (id: string) => string) {}

  start(actor: Actor, raw: unknown) {
    if (this.closed) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
    const request = parseContract(StartResearchRunSchema, raw), replay = this.repository.researchRunReplay(actor, request)
    if (replay) return replay
    if (this.queue.size >= 32) throw new ResearchError('BIO_MODEL_BUDGET')
    const { purpose, expectedRevision, operationId, retryOfRunId, ...input } = request
    const prepared = this.inputs.prepare(actor, parseContract(PublicInputRequestSchema, input))
    const result = this.repository.beginResearchRun(actor, request, prepared)
    this.queue.set(result.run.id, { prepared, controller: new AbortController() })
    // Return the persisted acceptance before entering model execution.
    this.schedule()
    return result
  }
  get(actor: Actor, id: string) { return this.repository.researchRunView(actor, id) }
  replay(actor: Actor, input: unknown) { return this.repository.researchRunReplay(actor, input) }
  list(actor: Actor, sessionId: string, pageSize: number, cursor?: string) { return this.repository.listResearchRuns(actor, sessionId, pageSize, cursor) }
  cancel(actor: Actor, id: string, generation: number) {
    this.repository.advanceRun(actor, id, 'cancelled', generation, null, Date.now())
    this.queue.get(id)?.controller.abort()
    return this.get(actor, id)
  }
  async idle(): Promise<void> { while (this.working) await this.working }
  async close(): Promise<void> {
    this.closed = true
    let failed = false
    for (const [id, item] of this.queue) {
      try { this.repository.interruptResearchRun(id) } catch { failed = true } finally { item.controller.abort() }
    }
    await this.idle()
    await this.recovering
    if (failed) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
  }
  async reconcile(actor: Actor, id: string) {
    const view = this.get(actor, id)
    if (view.run.state === 'completed') await this.sessions.reconcileResearchSession(actor, view.run.sessionId)
    return this.get(actor, id)
  }
  recoverProjections(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.recovering) return this.recovering
    this.recovering = (async () => {
      const pending = this.repository.pendingResearchProjections(this.projectionCursor)
      this.projectionCursor = pending.length === 20 ? pending.at(-1)! : ''
      for (const id of pending) {
        try { await this.reconcile(this.repository.researchExecutionActor(id), id) } catch {
          // Current authority or disk may be unavailable. Keep the journal pending;
          // retry after authority is restored, without an old client login or model call.
        }
      }
    })().finally(() => { this.recovering = undefined })
    return this.recovering
  }
  private async pump() {
    for (const [id, item] of this.queue) {
      try { if (!item.controller.signal.aborted) await this.execute(id, item) }
      finally { this.queue.delete(id) }
    }
  }
  private schedule(): void {
    if (this.working || this.closed) return
    this.working = new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => this.pump()).finally(() => {
      this.working = undefined
      if (this.queue.size) this.schedule()
    })
    // idle()/close() still observe failures, including callers that start a run and disconnect.
    void this.working.catch(() => {})
  }
  private async execute(id: string, { prepared, controller }: QueuedRun) {
    const workerId = randomUUID(); let generation = 0, monitor: ReturnType<typeof setInterval> | undefined
    const authority = () => {
      const actor = this.repository.researchExecutionActor(id)
      this.repository.assertResearchRunLease(actor, id, generation, workerId)
      prepared.assertCurrent()
      if (controller.signal.aborted) throw new ResearchError('BIO_MODEL_CANCELLED')
      return actor
    }
    try {
      const actor = this.repository.researchExecutionActor(id), view = this.get(actor, id)
      generation = view.run.generation
      // Worker timeout is capped at 180 seconds. Lease also covers validation/commit.
      this.repository.advanceRun(actor, id, 'running', generation, workerId, Date.now(), Date.now() + 240000)
      const record = this.repository.researchRunPreparation(actor, id)
      if (record.manifest.id !== prepared.manifest.id || record.manifest.contextHash !== prepared.manifest.contextHash || record.connectionFingerprint !== prepared.connection.fingerprint) throw new ResearchError('BIO_REVISION_CONFLICT')
      monitor = setInterval(() => {
        try { authority() } catch {
          try { this.repository.interruptResearchRun(id) } catch { /* recover from the authoritative store after restart */ } finally { controller.abort() }
        }
      }, 250)
      const reused = record.request.retryOfRunId ? this.repository.researchRetryCandidate(actor, record.request.retryOfRunId, prepared, record.request.purpose) : undefined
      const candidate = reused ? validatePublicCandidate(prepared, record.request.purpose, JSON.stringify(reused.content)) : await this.executor.generatePrepared(actor, prepared, record.request.purpose, controller.signal, async event => {
        const current = authority()
        this.repository.recordResearchModelAttempt(current, id, generation, workerId, prepared.manifest.id, event)
      })
      const current = authority()
      this.repository.saveResearchCandidate(current, id, generation, workerId, candidate, prepared, reused ? record.request.retryOfRunId : undefined)
      this.repository.completeResearchRun(current, id, generation, workerId, () => {
        prepared.assertCurrent()
        const reusable = reused ? this.repository.researchRetryArtifact(current, id) : undefined
        const artifact = reusable ? (reusable.kind === 'evidence' ? this.artifacts.evidenceView(current, reusable.id).revision : this.artifacts.reportView(current, reusable.id).revision)
          : this.artifacts.createGeneratedCandidate(current, view.run.sessionId, candidate)
        const session = parseContract(SessionSchema, this.repository.get(current, 'session', view.run.sessionId))
        const previous = this.repository.readProjection(current, session.id).at(-1), now = Date.now()
        const stored: StoredSession = { id: session.id, workspaceRootPath: this.workspace(session.id), createdAt: session.createdAt, lastUsedAt: now, name: session.name,
          model: prepared.connection.model.id, llmConnection: prepared.connection.slug, connectionLocked: true,
          tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
          messages: [...(previous?.messages ?? []), { id: randomUUID(), type: 'user', content: prepared.modelInput.question, timestamp: view.run.createdAt },
            { id: randomUUID(), type: 'assistant', content: JSON.stringify({ kind: candidate.kind, revisionId: artifact.id, reviewStatus: artifact.reviewStatus, content: candidate.content }), timestamp: now }] as unknown as StoredSession['messages'] }
        return { artifact: { kind: candidate.kind, id: artifact.id }, ...this.sessions.researchSessionSnapshot(stored) }
      })
      // A filesystem failure is recoverable from the committed full journal. Never rebill it.
      await this.sessions.reconcileResearchSession(current, view.run.sessionId).catch(() => {})
    } catch (error) {
      try {
        const actor = this.repository.researchExecutionActor(id), view = this.get(actor, id)
        if (view.run.state === 'running') this.repository.failResearchRun(actor, id, generation, workerId, error instanceof ResearchError ? error.code : 'BIO_MODEL_UNAVAILABLE')
        else if (view.run.state === 'queued') this.repository.interruptResearchRun(id)
      } catch { try { this.repository.interruptResearchRun(id) } catch { controller.abort() } }
    } finally { if (monitor) clearInterval(monitor) }
  }
}
