import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { ResearchConnectionBroker, PublicInputService } from './public-input'
import { ArtifactsService } from './artifacts-service'
import { ResearchRunService } from './research-run-service'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
import { join, relative, isAbsolute, sep } from 'node:path'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { SessionManager } from '../sessions/SessionManager'
import { SessionProjectionService } from './projection-service'
import { getSessionFilePath } from '@craft-agent/shared/sessions'
import { readSessionJsonl } from '@craft-agent/shared/sessions/jsonl'
import { BioAuthService } from './auth-service'

const actor = { userId: 'alice', authSessionId: 'expired-client-login', active: true, administrator: false }, scope = { kind: 'personal', ownerId: 'alice' } as const
const request = { sessionId: 'session', connectionId: 'official', model: 'synthetic-gpt', question: 'Public question', declaredPublic: true as const, blocks: [{ snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18 }], evidenceRevisionIds: [], purpose: 'evidence' as const, expectedRevision: 1, operationId: 'request-1' }
let repo: SqliteResearchRepository, runs: ResearchRunService, calls: number, release: (() => void) | undefined, projectFailure: boolean, snapshotFailure: boolean, signal: AbortSignal | undefined
let root: string
let projection: SessionProjectionService | undefined
let requestTool = false
beforeEach(() => {
  root = mkdtempSync(join(resolveConfigDir(), 't14-runs-'))
  repo = new SqliteResearchRepository(join(root, 'research.sqlite')); calls = 0; release = undefined; projectFailure = false; snapshotFailure = false; signal = undefined
  projection = undefined; requestTool = false
  repo.seedUser({ id: 'alice', username: 'alice', passwordHash: 'synthetic', active: true, administrator: false, revision: 1 })
  repo.put(actor, 'source', { id: 'source', scope, policy: 'public', provider: 'pdf-import', identifiers: {}, license: { status: 'unknown' }, createdAt: 1 })
  repo.put(actor, 'snapshot', { id: 'snapshot', sourceId: 'source', scope, policy: 'public', license: { status: 'unknown' }, format: 'pdf', acquiredBy: 'declared-public-pdf', retrievedAt: 1, contentHash: 'a'.repeat(64), coverage: { level: 'full', totalUnits: 1, units: [{ unit: 1, status: 'read' }] }, blocks: [{ id: 'block', unit: 1, text: 'Synthetic evidence', locator: { kind: 'pdf-page', page: 1 } }] })
  repo.put(actor, 'session', { id: 'session', scope, ownerId: actor.userId, name: 'Research', policy: 'public', selectedSourceIds: ['source'], revision: 1, createdAt: 1 })
  const broker = new ResearchConnectionBroker(repo, () => [{ slug: 'official', name: 'Official', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', enabled: true, revision: 1, scopes: [scope], models: [{ id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 }] }], async () => 'synthetic')
  runs = new ResearchRunService(repo, new PublicInputService(repo, broker), { generatePrepared: async (_actor, prepared, _purpose, _signal, observer, control) => {
    signal = _signal
    calls++; await observer!({ phase: 'send', callId: 'call-1' })
    if (requestTool) {
      await control!.toolEvent({ phase: 'request', id: 'runtime-tool', reference: { name: 'get_public_block', arguments: { snapshotId: 'snapshot', blockId: 'block' } } })
      await control!.toolEvent({ phase: 'completed', id: 'runtime-tool', isError: false })
    }
    if (release) await new Promise<void>(resolve => { release = resolve })
    await observer!({ phase: 'received', callId: 'call-1', outcome: 'completed' })
    return { kind: 'evidence', content: { claim: prepared.modelInput.question, factSummary: '', limitations: '', missingInformation: [], citations: [{ snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18, quote: 'Synthetic evidence' }] }, structuralStatus: 'structure-valid', reviewStatus: 'unreviewed' }
  } }, new ArtifactsService(repo), { researchSessionSnapshot: session => { if (snapshotFailure) throw Error('synthetic snapshot failure'); return { header: JSON.parse(JSON.stringify({ id: session.id, workspaceRootPath: session.workspaceRootPath, createdAt: session.createdAt, lastUsedAt: session.lastUsedAt, messageCount: session.messages.length, tokenUsage: session.tokenUsage })), messages: JSON.parse(JSON.stringify(session.messages)) } }, reconcileResearchSession: async (current, id) => { if (projectFailure) throw Error('synthetic disk failure'); await projection?.reconcile(current, id) } }, () => join(root, 'workspace'))
})
afterEach(async () => {
  release?.(); await runs.close(); repo.close()
  const offset = relative(realpathSync.native(resolveConfigDir()), realpathSync.native(root))
  if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned cleanup boundary')
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})
test('replay and client expiry do not repeat model calls; a complete unreviewed artifact and full journal commit together', async () => {
  const first = runs.start(actor, request), replay = runs.start(actor, request)
  expect(first.run.id).toBe(replay.run.id)
  await runs.idle()
  const view = runs.get(actor, first.run.id)
  expect(view.run.state).toBe('completed'); expect(view.run.artifactIds).toHaveLength(1)
  expect(calls).toBe(1)
  expect(repo.get(actor, 'evidence', view.run.artifactIds[0]!)).toMatchObject({ reviewStatus: 'unreviewed', policy: 'public' })
  expect(repo.readProjection(actor, 'session').at(-1)?.messages).toHaveLength(2)
  expect(repo.hasUnclassifiedProjection(actor, 'session')).toBe(false)
  expect(runs.start(actor, request).run.id).toBe(first.run.id)
  await runs.idle(); expect(calls).toBe(1)
  runs.start(actor, { ...request, operationId: 'request-2' }); await runs.idle()
  expect(calls).toBe(2); expect(repo.readProjection(actor, 'session').at(-1)?.messages).toHaveLength(4)
})
test('cancel is durable before abort and rejects late model output', async () => {
  release = () => {}
  const first = runs.start(actor, request)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(calls).toBe(1)
  expect(runs.cancel(actor, first.run.id, 0).run).toMatchObject({ state: 'cancelled', generation: 1 })
  release!(); await runs.idle()
  expect(runs.get(actor, first.run.id).modelRequests).toEqual([{ callId: 'call-1', state: 'unknown' }])
  expect(repo.listArtifactHeads(actor, 'session', 100).items).toEqual([])
  expect(repo.readProjection(actor, 'session')).toEqual([])
})
test('projection failure leaves completed database output recoverable without a second model request', async () => {
  projectFailure = true
  const first = runs.start(actor, request); await runs.idle()
  expect(runs.get(actor, first.run.id)).toMatchObject({ run: { state: 'completed' }, projectionPending: true })
  runs.start(actor, request); await runs.idle(); expect(calls).toBe(1)
})
test('artifact/journal failure rolls back both and explicit retry reuses the durable validated result', async () => {
  snapshotFailure = true
  const first = runs.start(actor, request); await runs.idle()
  expect(runs.get(actor, first.run.id).run.state).toBe('failed')
  expect(repo.listArtifactHeads(actor, 'session', 100).items).toEqual([])
  expect(repo.readProjection(actor, 'session')).toEqual([])
  snapshotFailure = false
  const retry = runs.start(actor, { ...request, operationId: 'retry-1', retryOfRunId: first.run.id }); await runs.idle()
  expect(runs.get(actor, retry.run.id).run.state).toBe('completed'); expect(calls).toBe(1)
})
test('a real expired auth session stops authenticating while owned background execution continues', async () => {
  let clock = 99
  const auth = await BioAuthService.create(repo, () => clock)
  repo.issueAuthSession({ id: 'timed-login', userId: actor.userId, tokenHash: 'b'.repeat(64), expiresAt: 100 }, 1)
  const loggedIn = auth.resolveActor('timed-login')!
  expect(loggedIn).not.toBeNull()
  release = () => {}
  const first = runs.start(loggedIn, request); await new Promise(resolve => setTimeout(resolve, 30))
  clock = 101; expect(auth.resolveActor('timed-login')).toBeNull()
  release!(); await runs.idle(); expect(runs.get(actor, first.run.id).run.state).toBe('completed')
  expect(calls).toBe(1)
})
test('account revocation aborts owned execution and retains unknown provider state', async () => {
  repo.seedUser({ id: 'admin', username: 'admin', passwordHash: 'synthetic', active: true, administrator: true, revision: 1 })
  const admin = { ...actor, userId: 'admin' }
  release = () => {}; const first = runs.start(actor, request)
  await new Promise(resolve => setTimeout(resolve, 30))
  repo.setAccountActive(admin, actor.userId, false, 1)
  await new Promise(resolve => setTimeout(resolve, 300)); expect(signal?.aborted).toBe(true)
  release!(); await runs.idle(); repo.setAccountActive(admin, actor.userId, true, 2)
  expect(runs.get(actor, first.run.id)).toMatchObject({ run: { state: 'interrupted', generation: 1 }, modelRequests: [{ callId: 'call-1', state: 'unknown' }] })
  expect(repo.listArtifactHeads(actor, 'session', 100).items).toEqual([])
})
test('restart reconciles a committed pending full snapshot through real SessionManager without model replay', async () => {
  projectFailure = true
  const first = runs.start(actor, request); await runs.idle(); await runs.close(); repo.close()
  repo = new SqliteResearchRepository(join(root, 'research.sqlite')); expect(repo.recoverResearchRuns()).toBe(0)
  const sessions = new SessionManager(), workspace = () => join(root, 'workspace')
  sessions.configureResearchProjection(new SessionProjectionService(repo, workspace))
  const broker = new ResearchConnectionBroker(repo, () => [], async () => { throw Error('Unexpected credential access') })
  runs = new ResearchRunService(repo, new PublicInputService(repo, broker), { generatePrepared: async () => { throw Error('Unexpected model replay') } }, new ArtifactsService(repo), sessions, workspace)
  await runs.recoverProjections()
  expect(runs.get(actor, first.run.id).projectionPending).toBe(false)
  expect(readSessionJsonl(getSessionFilePath(workspace(), 'session'))?.messages).toHaveLength(2)
  await runs.recoverProjections(); expect(calls).toBe(1)
})
test('explicit retry of completed work reuses its artifact revision and preserves later human edits', async () => {
  const first = runs.start(actor, request); await runs.idle()
  const old = runs.get(actor, first.run.id).run.artifactIds[0]!
  const artifact = new ArtifactsService(repo).evidenceView(actor, old).revision
  const human = new ArtifactsService(repo).saveEvidence(actor, { evidenceId: artifact.evidenceId, expectedRevision: 1, claim: 'Human correction', citations: artifact.citations, declaredPublic: true })
  const retry = runs.start(actor, { ...request, operationId: 'retry-completed', retryOfRunId: first.run.id }); await runs.idle()
  expect(runs.get(actor, retry.run.id).run.artifactIds).toEqual([old]); expect(calls).toBe(1)
  expect(repo.listArtifactHeads(actor, 'session', 100).items).toHaveLength(1)
  expect(repo.artifactHead(actor, 'evidence', artifact.evidenceId).id).toBe(human.id)
})
test('different sessions queue behind a single active model worker', async () => {
  repo.put(actor, 'session', { ...repo.get(actor, 'session', 'session'), id: 'second-session' })
  release = () => {}; const first = runs.start(actor, request)
  const second = runs.start(actor, { ...request, sessionId: 'second-session' })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(calls).toBe(1); expect(runs.get(actor, second.run.id).run.state).toBe('queued')
  const unblock = release!; release = undefined; unblock(); await runs.idle()
  expect(runs.get(actor, first.run.id).run.state).toBe('completed')
  expect(runs.get(actor, second.run.id).run.state).toBe('completed'); expect(calls).toBe(2)
})
test('unclassified appended history blocks the next cloud run before model execution', async () => {
  runs.start(actor, request); await runs.idle()
  repo.appendProjection(actor, 'session', 'unknown-history', [{ id: 'unknown-message', role: 'user', content: 'Synthetic unclassified material', timestamp: 1 }], 0)
  expect(() => runs.start(actor, { ...request, operationId: 'blocked-history' })).toThrow(expect.objectContaining({ code: 'BIO_POLICY_DENIED' }))
  expect(calls).toBe(1)
})
test('a later projected full snapshot covers earlier pending run messages across restart', async () => {
  projectFailure = true
  const first = runs.start(actor, request); await runs.idle()
  expect(runs.get(actor, first.run.id).projectionPending).toBe(true)
  projectFailure = false; projection = new SessionProjectionService(repo, () => join(root, 'workspace'))
  const second = runs.start(actor, { ...request, operationId: 'request-2' }); await runs.idle()
  expect(runs.get(actor, second.run.id).projectionPending).toBe(false)
  expect(runs.get(actor, first.run.id)).toMatchObject({ projectionPending: false, projectionStatus: 'covered' })
  await runs.close(); repo.close(); repo = new SqliteResearchRepository(join(root, 'research.sqlite'))
  expect(repo.researchRunView(actor, first.run.id)).toMatchObject({ projectionPending: false, projectionStatus: 'covered' })
  expect(repo.researchRunView(actor, second.run.id)).toMatchObject({ projectionPending: false, projectionStatus: 'projected' })
  expect(readSessionJsonl(getSessionFilePath(join(root, 'workspace'), 'session'))?.messages).toHaveLength(4)
})

test('Ask queue waits for persisted owner approval, and cancellation releases a pending tool', async () => {
  requestTool = true
  const first = runs.start(actor, { ...request, executionMode: 'ask' })
  const pending = async (id: string) => { const deadline = Date.now() + 2000; while (!runs.get(actor, id).trace?.some(item => item.id === 'runtime-tool' && item.state === 'pending')) { if (Date.now() > deadline) throw Error('Tool did not reach approval'); await new Promise(resolve => setTimeout(resolve, 10)) } }
  await pending(first.run.id)
  expect(runs.get(actor, first.run.id).modelRequests).toEqual([{ callId: 'call-1', state: 'pending' }])
  runs.decideTool(actor, { runId: first.run.id, expectedGeneration: 0, requestId: 'runtime-tool', decision: 'approve' })
  await runs.idle()
  expect(runs.get(actor, first.run.id)).toMatchObject({ run: { state: 'completed' }, trace: [expect.objectContaining({ kind: 'guard' }), expect.objectContaining({ kind: 'model' }), expect.objectContaining({ kind: 'tool', state: 'completed' }), expect.objectContaining({ kind: 'validate' })] })
  const second = runs.start(actor, { ...request, operationId: 'second-ask', executionMode: 'ask' })
  await pending(second.run.id)
  runs.cancel(actor, second.run.id, 0)
  await runs.idle()
  expect(runs.get(actor, second.run.id)).toMatchObject({ run: { state: 'cancelled' } })
  expect(runs.get(actor, second.run.id).trace?.find(item => item.kind === 'tool')?.state).toBe('interrupted')
})
