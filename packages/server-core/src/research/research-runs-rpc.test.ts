import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { ResearchError, RESEARCH_CHANNELS as R } from '@bio-evidence/research-core'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { deserializeEnvelope } from '../transport/codec'
import { SqliteResearchRepository } from './sqlite-repository'
import { createBioAuthorityServer } from './authority-server'
import { registerResearchRpcProfile } from './rpc-profile'
import { ResearchRunService } from './research-run-service'
import { ResearchConnectionBroker, PublicInputService } from './public-input'
import { PublicModelExecutor } from './public-model-executor'
import { PublicModelWorkerService } from './public-model-worker'
import { SessionManager } from '../sessions/SessionManager'
import { SessionProjectionService } from './projection-service'
import { ArtifactsService } from './artifacts-service'

test('two authenticated clients observe one durable run across logout; actual isolated SDK worker and RPC deny replay forgery', async () => {
  const parent = realpathSync.native(resolveConfigDir()), root = mkdtempSync(join(parent, 't14-rpc-')), workerPath = join(root, 'worker.ts'), marker = join(root, 'requests.txt')
  const repo = new SqliteResearchRepository(join(root, 'research.sqlite')), authority = await createBioAuthorityServer(repo, { port: 0 }), worker = new PublicModelWorkerService({ workerPath })
  const sockets: WebSocket[] = []; let runs: ResearchRunService | undefined
  try {
    const password = 'Synthetic-runs-password-9!'
    await authority.auth.createAccount(null, 'alice', password, true); const alice = await authority.auth.login('alice', password), otherLogin = await authority.auth.login('alice', password)
    await authority.auth.createAccount(alice.actor, 'bob', password); const bob = await authority.auth.login('bob', password)
    const scope = { kind: 'personal', ownerId: alice.actor.userId } as const
    repo.put(alice.actor, 'source', { id: 'source', scope, policy: 'public', provider: 'pdf-import', identifiers: {}, license: { status: 'unknown' }, createdAt: 1 })
    repo.put(alice.actor, 'snapshot', { id: 'snapshot', sourceId: 'source', scope, policy: 'public', license: { status: 'unknown' }, format: 'pdf', acquiredBy: 'declared-public-pdf', retrievedAt: 1, contentHash: 'a'.repeat(64), coverage: { level: 'full', totalUnits: 1, units: [{ unit: 1, status: 'read' }] }, blocks: [{ id: 'block', unit: 1, text: 'Synthetic evidence', locator: { kind: 'pdf-page', page: 1 } }] })
    repo.put(alice.actor, 'session', { id: 'session', scope, ownerId: alice.actor.userId, name: 'Research', policy: 'public', selectedSourceIds: ['source'], revision: 1, createdAt: 1 })
    const content = { claim: 'Synthetic generated claim', citations: [{ snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18, quote: 'Synthetic evidence' }] }
    const output = { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(content), annotations: [] }] }
    const response = { id: 'resp_synthetic', object: 'response', status: 'completed', model: 'synthetic-gpt', output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: output.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: output.id, output_index: 0, content_index: 0, delta: JSON.stringify(content) }, { type: 'response.output_item.done', output_index: 0, item: output }, { type: 'response.completed', response }]
    const stream = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    // Only this test wrapper replaces HTTP. The production worker, SDK and IPC protocol run unchanged.
    writeFileSync(workerPath, `import { appendFileSync } from 'node:fs'; globalThis.fetch = async () => { appendFileSync(${JSON.stringify(marker)}, 'request\\n'); return new Response(${JSON.stringify(stream)}, {headers:{'Content-Type':'text/event-stream'}}) }; await import(${JSON.stringify(pathToFileURL(resolve('packages/server-core/src/research/public-pi-worker.ts')).href)});`)
    const broker = new ResearchConnectionBroker(repo, () => [{ slug: 'official', name: 'Official', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', enabled: true, revision: 1, scopes: [scope], models: [{ id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 }] }], async () => 'synthetic-selected-key')
    const inputs = new PublicInputService(repo, broker), sessions = new SessionManager(), workspace = () => join(root, 'workspace')
    sessions.configureResearchProjection(new SessionProjectionService(repo, workspace)); sessions.setEventSink((channel, target, ...args) => authority.server.push(channel, target, ...args))
    runs = new ResearchRunService(repo, inputs, new PublicModelExecutor(repo, inputs, broker, worker), new ArtifactsService(repo), sessions, workspace)
    const profile = registerResearchRpcProfile(authority.server, repo, undefined, undefined, undefined, undefined, new ArtifactsService(repo), undefined, runs)
    await authority.server.listen()
    const connect = async (login: typeof alice) => {
      const ws = new WebSocket(`ws://127.0.0.1:${authority.server.port}`); sockets.push(ws); const seen: any[] = []
      ws.on('message', data => { const frame = deserializeEnvelope(data.toString()); if (frame.type === 'event') seen.push(frame) })
      await new Promise<void>(resolve => { ws.once('open', () => ws.send(JSON.stringify({ id: 'auth', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: login.token }))); ws.once('message', () => resolve()) })
      return { seen, invoke: (channel: string, input: unknown) => new Promise<any>(resolve => {
        const id = crypto.randomUUID(), listener = (data: WebSocket.RawData) => { const frame = deserializeEnvelope(data.toString()); if (frame.id === id) { ws.off('message', listener); resolve(frame) } }
        ws.on('message', listener); ws.send(JSON.stringify({ id, type: 'request', channel, args: [input] }))
      }) }
    }
    const first = await connect(alice), second = await connect(otherLogin), outsider = await connect(bob)
    const input = { sessionId: 'session', connectionId: 'official', model: 'synthetic-gpt', question: 'Public synthetic question', declaredPublic: true, blocks: [{ snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18 }], evidenceRevisionIds: [], purpose: 'evidence', expectedRevision: 1, operationId: 'request-1' }
    const accepted = await first.invoke(R.START_RUN, input); expect(accepted.error).toBeUndefined()
    authority.auth.logout(alice.actor)
    await runs.idle()
    expect((await first.invoke(R.GET_RUN, { runId: accepted.result.run.id })).error).toBeDefined()
    const completed = await second.invoke(R.GET_RUN, { runId: accepted.result.run.id })
    expect(completed.result.run.state).toBe('completed'); expect(completed.result.projectionPending).toBe(false)
    expect(completed.result.input.blocks[0].text).toBe('Synthetic evidence')
    expect(completed.result.modelRequests).toEqual([{ callId: 'call-1', state: 'completed' }])
    expect((await second.invoke(R.START_RUN, input)).result.run.id).toBe(accepted.result.run.id)
    expect((await outsider.invoke(R.GET_RUN, { runId: accepted.result.run.id })).error.code).toBe('BIO_ACCESS_DENIED')
    expect((await outsider.invoke(R.LIST_RUNS, { sessionId: 'session' })).error.code).toBe('BIO_ACCESS_DENIED')
    for (const changed of [{ question: 'Forged question' }, { blocks: [{ snapshotId: 'snapshot', blockId: 'block', start: 0, end: 10 }] }, { expectedRevision: 2 }]) expect(() => profile.gate.authorizeResponse(otherLogin.actor, R.START_RUN, [{ ...input, ...changed }], completed.result)).toThrow()
    const cancelRequest = { ...input, operationId: 'cancel-request' }, pending = repo.beginResearchRun(otherLogin.actor, cancelRequest, inputs.prepare(otherLogin.actor, { sessionId: input.sessionId, connectionId: input.connectionId, model: input.model, question: input.question, declaredPublic: true, blocks: input.blocks, evidenceRevisionIds: [] }))
    expect(() => profile.gate.authorizeResponse(otherLogin.actor, R.CANCEL_RUN, [{ runId: pending.run.id, expectedGeneration: 0 }], pending)).toThrow()
    const cancelled = await second.invoke(R.CANCEL_RUN, { runId: pending.run.id, expectedGeneration: 0 }); expect(cancelled.result.run.generation).toBe(1)
    expect(() => profile.gate.authorizeResponse(otherLogin.actor, R.CANCEL_RUN, [{ runId: pending.run.id, expectedGeneration: 1 }], cancelled.result)).toThrow()
    expect((await second.invoke(R.LIST_RUNS, { sessionId: 'session', pageSize: 1 })).result.items).toHaveLength(1)
    repo.publishResearchOutbox(event => sessions.publishResearchEvent(event)); await new Promise(resolve => setTimeout(resolve, 20))
    expect(second.seen.some(frame => frame.channel === R.EVENT && frame.args[0].kind === 'run-changed')).toBe(true)
    expect(outsider.seen).toEqual([]); expect(JSON.stringify(second.seen)).not.toContain(input.question)
    const original = repo.recordResearchModelAttempt.bind(repo)
    repo.recordResearchModelAttempt = () => { throw new ResearchError('BIO_STORAGE_UNAVAILABLE') }
    const blocked = await second.invoke(R.START_RUN, { ...input, operationId: 'storage-failure' }); await runs.idle()
    repo.recordResearchModelAttempt = original
    expect(runs.get(otherLogin.actor, blocked.result.run.id)).toMatchObject({ run: { state: 'failed' }, errorCode: 'BIO_STORAGE_UNAVAILABLE' })
    expect(readFileSync(marker, 'utf8')).toBe('request\n'); expect(worker.activeProcessIds).toEqual([])
  } finally {
    for (const socket of sockets) socket.terminate()
    authority.server.close(); await runs?.close(); await worker.close(); repo.close()
    const offset = relative(parent, realpathSync.native(root))
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned cleanup boundary')
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}, 30000)
