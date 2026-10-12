import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import WebSocket from 'ws'
import { WsRpcServer } from '../transport/server'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { SqliteResearchRepository } from './sqlite-repository'
import { BioAuthService } from './auth-service'
import { AuthBoundary, actorFromHeaders } from './auth-http'
import type { IncomingMessage } from 'node:http'
const password = 'Synthetic-passphrase-9!'
const headersOf = (request: IncomingMessage) => new Headers(Object.entries(request.headers).flatMap(([key, value]) => value ? [[key, Array.isArray(value) ? value.join(', ') : value]] : []))
describe('user identity on real WebSocket transport', () => {
  let repo: SqliteResearchRepository, auth: BioAuthService, server: WsRpcServer, now: number
  let login: Awaited<ReturnType<BioAuthService['login']>>, sockets: WebSocket[]
  beforeEach(async () => {
    sockets = []; now = 1000; repo = new SqliteResearchRepository(); auth = await BioAuthService.create(repo, () => now)
    await auth.createAccount(null, 'admin', password, true); login = await auth.login('admin', password)
    const boundary = new AuthBoundary(() => `http://127.0.0.1:${server?.port ?? 0}`)
    server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async () => true,
      userAuth: {
        allowsUpgrade: request => boundary.allows(headersOf(request), { peerAddress: request.socket.remoteAddress ?? '', secure: false }),
        authenticate: async (request, token) => token ? (request.headers.cookie ? null : auth.authenticate(token)) : actorFromHeaders(auth, boundary, headersOf(request)),
        resolveActor: id => auth.resolveActor(id),
      } })
    server.handle('identity', ctx => ({ userId: ctx.actor?.userId, administrator: ctx.actor?.administrator }))
    await server.listen()
  })
  afterEach(() => { for (const socket of sockets) socket.terminate(); server.close(); repo.close() })
  async function connect(token: string | undefined, options: { origin?: string; cookie?: string; reconnectClientId?: string; frames?: any[] } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers: { ...(options.origin ? { Origin: options.origin } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}) } })
    sockets.push(ws)
    if (options.frames) ws.on('message', data => options.frames!.push(JSON.parse(data.toString())))
    return await new Promise<{ ws: WebSocket; id: string }>((resolve, reject) => {
      const timeout = setTimeout(() => { ws.terminate(); reject(Error('owned WS timeout')) }, 3000)
      ws.on('error', () => { clearTimeout(timeout); reject(Error('connection denied')) })
      ws.on('open', () => ws.send(JSON.stringify({ id: 'handshake-a', type: 'handshake', protocolVersion: PROTOCOL_VERSION,
        token, userId: 'forged', administrator: true, reconnectClientId: options.reconnectClientId, lastSeq: options.reconnectClientId ? 0 : undefined })))
      ws.once('message', bytes => {
        clearTimeout(timeout); const frame = JSON.parse(bytes.toString())
        if (frame.type === 'handshake_ack') resolve({ ws, id: frame.clientId }); else reject(Error('authentication denied'))
      })
      ws.once('close', () => { clearTimeout(timeout); reject(Error('connection denied')) })
    })
  }
  function invoke(ws: WebSocket, channel = 'identity') {
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('owned RPC timeout')), 3000)
      ws.once('message', data => { clearTimeout(timeout); resolve(JSON.parse(data.toString())) })
      ws.send(JSON.stringify({ id: 'request-a', type: 'request', channel, args: [{ userId: 'forged', administrator: true }] }))
    })
  }
  test('only the authenticated user session supplies RequestContext actor', async () => {
    const { ws } = await connect(login.token)
    expect((await invoke(ws)).result).toEqual({ userId: login.account.id, administrator: true })
  })
  test('legacy token cannot bypass user identity even with a permissive legacy validator', async () => {
    let rejected = false; try { await connect('old-server-token') } catch { rejected = true }; expect(rejected).toBe(true)
  })
  test('same-origin cookie succeeds and cross-origin cookie upgrade is denied', async () => {
    const cookie = `bio_session=${login.token}`
    const { ws } = await connect(undefined, { origin: `http://127.0.0.1:${server.port}`, cookie })
    expect((await invoke(ws)).result.userId).toBe(login.account.id)
    let rejected = false; try { await connect(undefined, { origin: 'https://evil.example', cookie }) } catch { rejected = true }; expect(rejected).toBe(true)
  })
  test('expiry prevents later RPC results and event delivery on an already connected socket', async () => {
    const { ws } = await connect(login.token)
    const frames: any[] = []; ws.on('message', frame => frames.push(JSON.parse(frame.toString())))
    now = login.expiresAt; server.push('private-content', { to: 'all' }, 'synthetic private body')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(frames.some(frame => frame.type === 'event')).toBe(false)
    expect(ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED).toBe(true)
  })
  test('logout during an awaited handler prevents its result from being sent', async () => {
    let ready!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { ready = resolve }), finish = new Promise<void>(resolve => { release = resolve })
    server.handle('slow', async () => { ready(); await finish; return 'synthetic private result' })
    const { ws } = await connect(login.token), response = invoke(ws, 'slow')
    await entered; auth.logout(login.actor); release()
    const frame = await response; expect(frame.result).toBeUndefined(); expect(frame.error.code).toBe('AUTH_FAILED')
  })
  test('reconnect cannot replay another account buffer by reusing its client ID', async () => {
    const first = await connect(login.token), closed = new Promise(resolve => first.ws.once('close', resolve))
    first.ws.close(); await closed
    server.push('private-content', { to: 'all' }, 'synthetic private buffer')
    await auth.createAccount(login.actor, 'student', password)
    const other = await auth.login('student', password)
    const second = await connect(other.token, { reconnectClientId: first.id })
    expect(second.id).not.toBe(first.id)
  })
  test('two handshakes during deferred authentication cannot create two identities on one socket', async () => {
    server.close(); let release!: () => void, calls = 0
    const waiting = new Promise<void>(resolve => { release = resolve })
    server = new WsRpcServer({ host: '127.0.0.1', port: 0, userAuth: {
      allowsUpgrade: () => true,
      authenticate: async (_request, token) => { calls++; await waiting; return auth.authenticate(token ?? '') },
      resolveActor: id => auth.resolveActor(id),
    } })
    await server.listen()
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`); sockets.push(ws); ws.on('error', () => {})
    await new Promise<void>(resolve => ws.once('open', resolve))
    for (const id of ['one', 'two']) ws.send(JSON.stringify({ id, type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: login.token }))
    await new Promise(resolve => setTimeout(resolve, 15)); release()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toBe(1); expect(server.getConnectedClientCount() <= 1).toBe(true)
  })
  test('expiry during reconnect replay stops subsequent content frames', async () => {
    let reads = 0, expireAfter = Infinity
    auth = await BioAuthService.create(repo, () => ++reads >= expireAfter ? login.expiresAt : 1000)
    const first = await connect(login.token), closed = new Promise(resolve => first.ws.once('close', resolve))
    first.ws.close(); await closed
    server.push('private-content', { to: 'all' }, 'first synthetic frame')
    server.push('private-content', { to: 'all' }, 'second synthetic frame')
    expireAfter = reads + 4
    const frames: any[] = []
    await connect(login.token, { reconnectClientId: first.id, frames })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(frames.filter(frame => frame.type === 'event').length).toBe(1)
    expect(frames.some(frame => frame.type === 'event' && frame.args?.[0] === 'second synthetic frame')).toBe(false)
  })
})
