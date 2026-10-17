import { beforeEach, afterEach, expect, test } from 'bun:test'
import WebSocket from 'ws'
import { SqliteResearchRepository } from './sqlite-repository'
import { createBioAuthorityServer } from './authority-server'
import { createBioUiHttpAdapter } from './ui-http'
import { createDocumentsHttpAdapter } from './documents-http'
import { registerResearchRpcProfile } from './rpc-profile'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
let repo: SqliteResearchRepository, instance: Awaited<ReturnType<typeof createBioAuthorityServer>>, origin: string
let alice: Awaited<ReturnType<typeof instance.auth.login>>, bob: typeof alice, imported = 0
const sockets: WebSocket[] = []
let documents: ReturnType<typeof createDocumentsHttpAdapter>
beforeEach(async () => {
  repo = new SqliteResearchRepository(); let ui: ReturnType<typeof createBioUiHttpAdapter> | undefined
  instance = await createBioAuthorityServer(repo, { port: 0, additionalHttpHandler: (req, res) => documents?.(req, res) || ui?.(req, res) || false })
  await instance.auth.createAccount(null, 'alice', 'Synthetic-browser-binding-123!', true); alice = await instance.auth.login('alice', 'Synthetic-browser-binding-123!')
  await instance.auth.createAccount(alice.actor, 'bob', 'Synthetic-browser-binding-123!'); bob = await instance.auth.login('bob', 'Synthetic-browser-binding-123!')
  ui = createBioUiHttpAdapter(instance.auth, instance.boundary)
  imported = 0
  documents = createDocumentsHttpAdapter({ limits: { pdfMaxBytes: 1024, timeoutMs: 1000 }, authorizeSession: () => {}, importPdf: async () => { imported++; return { status: 'invalid' } }, validateResult: () => {} } as any, instance.auth, instance.boundary)
  registerResearchRpcProfile(instance.server, repo); await instance.server.listen(); origin = instance.boundary.publicOrigin
})
afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); instance.server.close(); await documents.close(); repo.close() })
const headers = (login: typeof alice, binding: string) => ({ Cookie: `bio_session=${login.token}`, 'X-Bio-Session-Binding': binding })
test('shared cookie replacement refuses old-tab current/config/upload/logout and does not clear or revoke the new cookie', async () => {
  const expected = alice.actor.authSessionId
  for (const path of ['/api/auth/session', '/api/config']) expect((await fetch(origin + path, { headers: headers(bob, expected) })).status).toBeGreaterThanOrEqual(400)
  const upload = await fetch(origin + '/api/research/sessions/shared/pdf?expectedRevision=1&declaredPublic=false', { method: 'POST', headers: { ...headers(bob, expected), Origin: origin, 'Content-Type': 'application/pdf' }, body: 'synthetic-private-PDF' })
  expect(upload.status).toBe(401); expect(imported).toBe(0)
  const logout = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { ...headers(bob, expected), Origin: origin } })
  expect(logout.status).toBeGreaterThanOrEqual(400); expect(logout.headers.get('set-cookie')).toBeNull()
  expect(instance.auth.authenticate(bob.token)?.userId).toBe(bob.actor.userId)
  const current = await fetch(origin + '/api/auth/session', { headers: headers(bob, bob.actor.authSessionId) })
  expect(await current.json()).toEqual({ account: bob.account, sessionBinding: bob.actor.authSessionId })
})
test('a bound logout emits no cookie write even if its response arrives after another login', async () => {
  const logout = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { ...headers(alice, alice.actor.authSessionId), Origin: origin } })
  expect(logout.status).toBe(200); expect(logout.headers.get('set-cookie')).toBeNull()
  expect(instance.auth.authenticate(alice.token)).toBeNull(); expect(instance.auth.authenticate(bob.token)).not.toBeNull()
})
test('cookie WS reconnection fixes the expected auth session rather than adopting another tab identity', async () => {
  const connect = (cookie: typeof alice, binding: string) => new Promise<any>(resolve => {
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/?bioBinding=' + binding, { headers: { Cookie: `bio_session=${cookie.token}`, Origin: origin } }); sockets.push(ws)
    const timer = setTimeout(() => { ws.terminate(); resolve({ type: 'timeout' }) }, 2000)
    const done = (frame: any) => { clearTimeout(timer); resolve(frame) }
    ws.once('open', () => ws.send(JSON.stringify({ id: 'auth', type: 'handshake', protocolVersion: PROTOCOL_VERSION })))
    ws.once('message', value => done(JSON.parse(value.toString()))); ws.once('close', () => done({ type: 'denied' })); ws.once('error', () => done({ type: 'denied' }))
  })
  expect((await connect(alice, alice.actor.authSessionId)).type).toBe('handshake_ack')
  expect((await connect(bob, alice.actor.authSessionId)).type).not.toBe('handshake_ack')
  expect((await connect(bob, bob.actor.authSessionId)).type).toBe('handshake_ack')
})
