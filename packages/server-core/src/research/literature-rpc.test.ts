import { expect, test } from 'bun:test'
import WebSocket from 'ws'
import { RESEARCH_CHANNELS as R } from '@bio-evidence/research-core'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { SqliteResearchRepository } from './sqlite-repository'
import { createBioAuthorityServer } from './authority-server'
import { registerResearchRpcProfile } from './rpc-profile'
import { LiteratureService } from './literature-service'
test('authenticated shared RPC searches, selects, reads immutable source and snapshot; forgery is refused', async () => {
  const repo = new SqliteResearchRepository(), server = await createBioAuthorityServer(repo, { port: 0 })
  let ws: WebSocket | undefined
  try {
    const password = 'Synthetic-literature-123!'
    await server.auth.createAccount(null, 'reader', password, true)
    const login = await server.auth.login('reader', password)
    const literature = new LiteratureService(repo, { search: async () => ({ items: [{ provider: 'europe-pmc', providerId: 'MED:123', identifiers: { pmid: '123' }, abstract: 'Synthetic public abstract', license: { status: 'unknown' }, availability: { abstract: true, fullText: false } }] }), record: async () => { throw Error('unused') }, openText: async () => { throw Error('unused') } }, { currentActor: actor => {
      const current = server.auth.resolveActor(actor.authSessionId); if (!current) throw Error('revoked'); return current
    } })
    registerResearchRpcProfile(server.server, repo, undefined, undefined, literature)
    await server.server.listen()
    ws = new WebSocket(`ws://127.0.0.1:${server.server.port}`)
    await new Promise<void>(resolve => { ws!.once('open', () => ws!.send(JSON.stringify({ id: 'login', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: login.token }))); ws!.once('message', () => resolve()) })
    const invoke = (channel: string, input: unknown) => new Promise<any>(resolve => { ws!.once('message', data => resolve(JSON.parse(data.toString()))); ws!.send(JSON.stringify({ id: crypto.randomUUID(), type: 'request', channel, args: [input] })) })
    const session = (await invoke(R.CREATE_SESSION, { scope: { kind: 'personal', ownerId: login.actor.userId }, name: 'Literature' })).result
    const page = await invoke(R.SEARCH, { sessionId: session.id, query: 'public synthetic' })
    expect(page.error).toBeUndefined(); expect(page.result.items).toHaveLength(1)
    const selected = await invoke(R.SELECT_SOURCE, { sessionId: session.id, candidateId: page.result.items[0].id, expectedRevision: 1 })
    expect(selected.error).toBeUndefined(); expect(selected.result.session.selectedSourceIds).toEqual([selected.result.source.id])
    expect((await invoke(R.GET_SOURCE, { sourceId: selected.result.source.id })).result).toEqual(selected.result.source)
    const reused = (await invoke(R.CREATE_SESSION, { scope: session.scope, name: 'Reuse', sourceIds: [selected.result.source.id] })).result
    expect(reused.selectedSourceIds).toEqual([selected.result.source.id])
    expect((await invoke(R.GET_SNAPSHOT, { snapshotId: selected.result.snapshot.id })).result.blocks[0].text).toBe('Synthetic public abstract')
    expect((await invoke(R.SELECT_SOURCE, { sessionId: session.id, candidateId: page.result.items[0].id, expectedRevision: 2, policy: 'public' })).error.code).toBe('BIO_INPUT_INVALID')
  } finally { ws?.terminate(); server.server.close(); repo.close() }
})
