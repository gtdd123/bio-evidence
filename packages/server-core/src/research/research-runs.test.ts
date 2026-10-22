import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { PublicInputService, ResearchConnectionBroker, type PreparedPublicInput } from './public-input'

const actor = { userId: 'alice', authSessionId: 'auth-alice', active: true, administrator: false }, scope = { kind: 'personal', ownerId: 'alice' } as const
const input = { sessionId: 'session', connectionId: 'official', model: 'synthetic-gpt', question: 'Public question', declaredPublic: true as const, blocks: [{ snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18 }], evidenceRevisionIds: [], purpose: 'evidence' as const, expectedRevision: 1, operationId: 'request-1' }
let repo: SqliteResearchRepository, prepared: PreparedPublicInput
beforeEach(() => {
  repo = new SqliteResearchRepository()
  repo.seedUser({ id: 'alice', username: 'alice', passwordHash: 'synthetic', active: true, administrator: false, revision: 1 })
  repo.put(actor, 'source', { id: 'source', scope, policy: 'public', provider: 'pdf-import', identifiers: {}, license: { status: 'unknown' }, createdAt: 1 })
  repo.put(actor, 'snapshot', { id: 'snapshot', sourceId: 'source', scope, policy: 'public', license: { status: 'unknown' }, format: 'pdf', acquiredBy: 'declared-public-pdf', retrievedAt: 1, contentHash: 'a'.repeat(64), coverage: { level: 'full', totalUnits: 1, units: [{ unit: 1, status: 'read' }] }, blocks: [{ id: 'block', unit: 1, text: 'Synthetic evidence', locator: { kind: 'pdf-page', page: 1 } }] })
  repo.put(actor, 'session', { id: 'session', scope, ownerId: actor.userId, name: 'Research', policy: 'public', selectedSourceIds: ['source'], revision: 1, createdAt: 1 })
  const broker = new ResearchConnectionBroker(repo, () => [{ slug: 'official', name: 'Official', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', enabled: true, revision: 1, scopes: [scope], models: [{ id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 }] }], async () => { throw Error('No key access while creating a run') })
  const { purpose, expectedRevision, operationId, ...publicInput } = input
  prepared = new PublicInputService(repo, broker).prepare(actor, publicInput)
})
afterEach(() => repo.close())

test('an operation replay returns the original queued run and a conflicting body cannot reuse its identity', () => {
  const first = repo.beginResearchRun(actor, input, prepared, 10)
  expect(first.run).toMatchObject({ state: 'queued', generation: 0, actorId: actor.userId })
  expect(first.manifest?.contextHash).toBe(prepared.manifest.contextHash)
  const replay = repo.beginResearchRun(actor, input, undefined, 11)
  expect(replay.run.id).toBe(first.run.id)
  expect(repo.listResearchRuns(actor, 'session', 100).items).toHaveLength(1)
  expect(() => repo.beginResearchRun(actor, { ...input, question: 'Different question' }, prepared, 12)).toThrow(expect.objectContaining({ code: 'BIO_REVISION_CONFLICT' }))
})

test('another operation cannot start while the same session is active; cancellation changes generation before a new run', () => {
  const first = repo.beginResearchRun(actor, input, prepared, 10)
  expect(() => repo.beginResearchRun(actor, { ...input, operationId: 'request-2' }, prepared, 11)).toThrow(expect.objectContaining({ code: 'BIO_RUN_ACTIVE' }))
  repo.advanceRun(actor, first.run.id, 'cancelled', 0, null, 12)
  expect(repo.researchRunView(actor, first.run.id).run).toMatchObject({ state: 'cancelled', generation: 1 })
  const next = repo.beginResearchRun(actor, { ...input, operationId: 'request-2' }, prepared, 13)
  expect(next.run.id).not.toBe(first.run.id)
  expect(() => repo.advanceRun(actor, first.run.id, 'running', 0, 'late-worker', 14, 100)).toThrow()
})

test('stale session revisions and impersonated owners cannot create a run', () => {
  expect(() => repo.beginResearchRun(actor, { ...input, expectedRevision: 2 }, prepared, 10)).toThrow(expect.objectContaining({ code: 'BIO_REVISION_CONFLICT' }))
  repo.seedUser({ id: 'bob', username: 'bob', passwordHash: 'synthetic', active: true, administrator: false, revision: 1 })
  expect(() => repo.beginResearchRun({ ...actor, userId: 'bob' }, input, prepared, 10)).toThrow(expect.objectContaining({ code: 'BIO_ACCESS_DENIED' }))
  expect(repo.listResearchRuns(actor, 'session', 100).items).toEqual([])
})

test('each model send is durable, sequential and bound to the current lease and manifest', () => {
  const { run, manifest } = repo.beginResearchRun(actor, input, prepared, 10)
  repo.advanceRun(actor, run.id, 'running', 0, 'worker', 11, 1000)
  const attempt = (phase: 'send' | 'received', callId: string, outcome?: 'completed' | 'rejected') => repo.recordResearchModelAttempt(actor, run.id, 0, 'worker', manifest.id, { phase, callId, ...(outcome ? { outcome } : {}) }, 12)
  attempt('send', 'call-1')
  expect(repo.researchRunView(actor, run.id).modelRequests).toEqual([{ callId: 'call-1', state: 'pending' }])
  expect(() => attempt('send', 'call-1')).toThrow()
  expect(() => attempt('send', 'call-2')).toThrow()
  expect(() => repo.recordResearchModelAttempt(actor, run.id, 0, 'worker', 'wrong-manifest', { phase: 'received', callId: 'call-1', outcome: 'completed' }, 12)).toThrow()
  attempt('received', 'call-1', 'completed'); attempt('send', 'call-2')
  repo.advanceRun(actor, run.id, 'cancelled', 0, null, 13)
  expect(repo.researchRunView(actor, run.id).modelRequests).toEqual([{ callId: 'call-1', state: 'completed' }, { callId: 'call-2', state: 'unknown' }])
  expect(() => attempt('received', 'call-2', 'completed')).toThrow()
})

test('startup interrupts orphaned work without replay and preserves unknown external side effects', () => {
  const { run, manifest } = repo.beginResearchRun(actor, input, prepared, 10)
  repo.advanceRun(actor, run.id, 'running', 0, 'worker', 11, 1000)
  repo.recordResearchModelAttempt(actor, run.id, 0, 'worker', manifest.id, { phase: 'send', callId: 'call-1' }, 12)
  expect(repo.recoverResearchRuns(14)).toBe(1)
  expect(repo.researchRunView(actor, run.id)).toMatchObject({ run: { state: 'interrupted', generation: 1 }, modelRequests: [{ callId: 'call-1', state: 'unknown' }] })
  expect(repo.recoverResearchRuns(15)).toBe(0)
  expect(repo.beginResearchRun(actor, input, undefined, 16).run.id).toBe(run.id)
})
test('large accumulated history is rejected before reading source content', () => {
  for (let index = 0; index < 5; index++) repo.appendProjection(actor, 'session', `history-${index}`, [{ id: 'message', role: 'user', content: 'a'.repeat(2 * 1024 * 1024), timestamp: 1 }], 0)
  expect(() => prepared.assertCurrent()).toThrow(expect.objectContaining({ code: 'BIO_MODEL_BUDGET' }))
})

test('Ask approvals bind the current owner, generation, concrete reference and one pending request', () => {
  const { run } = repo.beginResearchRun(actor, { ...input, executionMode: 'ask' }, prepared, 10)
  repo.advanceRun(actor, run.id, 'running', 0, 'worker', 11, 100000)
  const request = { phase: 'request', id: 'tool-request', reference: { name: 'get_public_block', arguments: { snapshotId: 'snapshot', blockId: 'block' } } }
  expect(repo.recordResearchToolEvent(actor, run.id, 0, 'worker', request, 12).state).toBe('pending')
  expect(() => repo.recordResearchToolEvent(actor, run.id, 0, 'worker', { phase: 'completed', id: 'tool-request', isError: false }, 13)).toThrow()
  expect(() => repo.decideResearchTool(actor, { runId: run.id, expectedGeneration: 1, requestId: 'tool-request', decision: 'approve' }, 13)).toThrow()
  repo.decideResearchTool(actor, { runId: run.id, expectedGeneration: 0, requestId: 'tool-request', decision: 'approve' }, 14)
  expect(() => repo.decideResearchTool(actor, { runId: run.id, expectedGeneration: 0, requestId: 'tool-request', decision: 'deny' }, 15)).toThrow()
  repo.recordResearchToolEvent(actor, run.id, 0, 'worker', { phase: 'completed', id: 'tool-request', isError: false }, 16)
  expect(repo.researchRunView(actor, run.id)).toMatchObject({ executionMode: 'ask', trace: [{ id: 'tool-request', state: 'completed', startedAt: 12, finishedAt: 16 }] })
  expect(repo.researchRunView(actor, run.id).steps).toEqual([{ id: 'prepare', state: 'completed' }])
})
test('tool references outside the frozen manifest and expired or cancelled approvals are denied', () => {
  const { run } = repo.beginResearchRun(actor, { ...input, executionMode: 'ask' }, prepared, 10)
  repo.advanceRun(actor, run.id, 'running', 0, 'worker', 11, 100000)
  expect(() => repo.recordResearchToolEvent(actor, run.id, 0, 'worker', { phase: 'request', id: 'wrong', reference: { name: 'get_public_block', arguments: { snapshotId: 'private', blockId: 'block' } } }, 12)).toThrow()
  repo.recordResearchToolEvent(actor, run.id, 0, 'worker', { phase: 'request', id: 'request', reference: { name: 'get_public_block', arguments: { snapshotId: 'snapshot', blockId: 'block' } } }, 12)
  expect(() => repo.decideResearchTool(actor, { runId: run.id, expectedGeneration: 0, requestId: 'request', decision: 'approve' }, 45013)).toThrow()
  repo.advanceRun(actor, run.id, 'cancelled', 0, null, 45014)
  expect(repo.researchRunView(actor, run.id).trace?.[0]?.state).toBe('interrupted')
  expect(() => repo.decideResearchTool(actor, { runId: run.id, expectedGeneration: 1, requestId: 'request', decision: 'approve' }, 45015)).toThrow()
})
