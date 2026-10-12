import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import WebSocket from 'ws'
import { request as httpRequest } from 'node:http'
import { SqliteResearchRepository } from './sqlite-repository'
import { createBioAuthorityServer } from './authority-server'
import { PROTOCOL_VERSION, isErrorCode } from '@craft-agent/shared/protocol'
import { loginDesktopAccount } from '@craft-agent/shared/auth/bio-client'
const password = 'Synthetic-passphrase-9!'
describe('BioEvidence production auth adapter and closed bootstrap', () => {
  let repo: SqliteResearchRepository, instance: Awaited<ReturnType<typeof createBioAuthorityServer>>, origin: string
  const sockets: WebSocket[] = []
  beforeEach(async () => {
    repo = new SqliteResearchRepository(); instance = await createBioAuthorityServer(repo, { port: 0 })
    await instance.auth.createAccount(null, 'admin', password, true); await instance.server.listen(); origin = instance.boundary.publicOrigin
  })
  afterEach(() => { for (const ws of sockets.splice(0)) ws.terminate(); instance.server.close(); repo.close() })
  test('Node HTTP adapter and shared desktop helper log in to the same persisted account', async () => {
    const login = await loginDesktopAccount(origin, 'admin', password)
    expect(instance.auth.authenticate(login.token)?.userId).toBe(login.account.id)
    const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) })
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')?.includes('HttpOnly')).toBe(true)
    expect((await fetch(origin + '/api/auth')).status).toBe(404)
  })
  test('unbounded chunked body is stopped before building a Request or hashing passwords', async () => {
    const status = await new Promise<number>(resolve => {
      const request = httpRequest(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode ?? 0))
      })
      request.on('error', () => resolve(0)); request.write('{"password":"' + 'x'.repeat(10000)); request.end('"}')
    })
    expect(status).toBe(413)
  })
  test('startup exposes no legacy handlers and a user session alone identifies a WS connection', async () => {
    const login = await loginDesktopAccount(origin, 'admin', password)
    const ws = new WebSocket(origin.replace('http:', 'ws:')); sockets.push(ws); ws.on('error', () => {})
    const ack = await new Promise<any>(resolve => {
      ws.once('open', () => ws.send(JSON.stringify({ id: 'a', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: login.token })))
      ws.once('message', data => resolve(JSON.parse(data.toString())))
    })
    expect(ack.registeredChannels).toEqual([])
    const frame = await new Promise<any>(resolve => {
      ws.once('message', data => resolve(JSON.parse(data.toString())))
      ws.send(JSON.stringify({ id: 'b', type: 'request', channel: 'sessions:getAll', args: [] }))
    })
    expect(frame.error.code).toBe('CHANNEL_NOT_FOUND')
    expect(isErrorCode('BIO_ACCESS_DENIED')).toBe(true)
  })
  test('a remote listener cannot be configured with plaintext or an implicit public origin', async () => {
    let rejected = false; try { await createBioAuthorityServer(repo, { host: '0.0.0.0' }) } catch { rejected = true }; expect(rejected).toBe(true)
  })
})
