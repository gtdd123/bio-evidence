import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { BioAuthService } from './auth-service'
import { AuthBoundary, createBioAuthHandler } from './auth-http'
const password = 'Synthetic-passphrase-9!'
describe('BioEvidence HTTP account login boundary', () => {
  let repo: SqliteResearchRepository, auth: BioAuthService, handler: ReturnType<typeof createBioAuthHandler>, server: ReturnType<typeof Bun.serve>, origin: string
  beforeEach(async () => {
    repo = new SqliteResearchRepository(); auth = await BioAuthService.create(repo)
    await auth.createAccount(null, 'admin', password, true)
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request, instance) {
      return handler(request, { peerAddress: instance.requestIP(request)?.address ?? '', secure: false })
    } })
    origin = server.url.origin; handler = createBioAuthHandler(auth, new AuthBoundary(origin))
  })
  afterEach(() => { server.stop(true); repo.close() })
  function login(extra: Record<string, string> = {}, body: Record<string, unknown> = { username: 'admin', password }) {
    return fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...extra }, body: JSON.stringify(body) })
  }
  test('browser login returns identity and HttpOnly cookie without a bearer in its body', async () => {
    const response = await login(), data = await response.json() as Record<string, unknown>
    expect(response.status).toBe(200); expect('token' in data).toBe(false); expect('actor' in data).toBe(false)
    const cookie = response.headers.get('set-cookie')!
    expect(cookie.includes('HttpOnly')).toBe(true); expect(cookie.includes('SameSite=Strict')).toBe(true)
    expect(cookie.includes('Max-Age=86400')).toBe(true); expect(response.headers.get('cache-control')).toBe('no-store')
    const status = await fetch(origin + '/api/auth/session', { headers: { Cookie: cookie.split(';')[0]! } })
    expect(status.status).toBe(200)
  })
  test('cross-origin, forged Host, proxy headers and client role fields fail closed', async () => {
    const attempts: Record<string, string>[] = [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }, { 'X-Forwarded-Proto': 'https' }]
    for (const headers of attempts) {
      expect((await login(headers)).status).toBe(403)
    }
    expect((await login({}, { username: 'admin', password, administrator: true, userId: 'forged' })).status).toBe(400)
  })
  test('desktop endpoint returns user token, rejects browser use and logout revokes it', async () => {
    const response = await fetch(origin + '/api/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) })
    expect(response.status).toBe(200); const data = await response.json() as { token: string }
    expect(auth.authenticate(data.token)?.administrator).toBe(true)
    const blocked = await fetch(origin + '/api/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ username: 'admin', password }) })
    expect(blocked.status).toBe(403)
    const logout = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${data.token}` } })
    expect(logout.status).toBe(200); expect(auth.authenticate(data.token)).toBeNull()
  })
  test('no legacy cookie or token fallback, and duplicate user cookies are rejected', async () => {
    const response = await login(); const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
    const attempts: Record<string, string>[] = [{ Cookie: 'craft_session=old' }, { Authorization: 'Bearer legacy-server' },
      { Cookie: `${cookie}; ${cookie}` }, { Cookie: cookie, Authorization: 'Bearer invalid' }]
    for (const headers of attempts) {
      expect((await fetch(origin + '/api/auth/session', { headers })).status).toBe(401)
    }
  })
  test('remote origins require TLS and forwarded proto is accepted only from an explicit trusted proxy', () => {
    expect(() => new AuthBoundary('http://lab.example')).toThrow()
    const headers = new Headers({ Host: 'lab.example', Origin: 'https://lab.example', 'X-Forwarded-Proto': 'https' })
    const secure = new AuthBoundary('https://lab.example')
    expect(secure.allows(headers, { peerAddress: '127.0.0.1', secure: false }, true)).toBe(false)
    const proxy = new AuthBoundary('https://lab.example', ['127.0.0.1'])
    expect(proxy.allows(headers, { peerAddress: '127.0.0.1', secure: false }, true)).toBe(true)
    expect(proxy.allows(headers, { peerAddress: '192.0.2.1', secure: false }, true)).toBe(false)
  })
  test('oversized and malformed bodies return safe failures without reflecting credentials', async () => {
    const huge = await login({}, { username: 'admin', password: 'x'.repeat(10000) })
    expect(huge.status).toBe(413)
    const bad = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{bad' })
    expect(bad.status).toBe(400); expect(await bad.text()).toBe('{"error":"BIO_INPUT_INVALID"}')
  })
  test('expiry between authentication and final account/logout checks stays a 401 and clears logout cookie', async () => {
    let reads = 0, expireAfter = Infinity
    auth = await BioAuthService.create(repo, () => ++reads >= expireAfter ? 86_401_000 : 1000)
    handler = createBioAuthHandler(auth, new AuthBoundary(origin))
    for (const path of ['session', 'logout']) {
      expireAfter = Infinity; const session = await auth.login('admin', password); expireAfter = reads + 2
      const response = await fetch(origin + '/api/auth/' + path, { method: path === 'session' ? 'GET' : 'POST',
        headers: { Cookie: `bio_session=${session.token}`, Origin: origin } })
      expect(response.status).toBe(401)
      if (path === 'logout') expect(response.headers.get('set-cookie')?.includes('Max-Age=0')).toBe(true)
    }
  })
})
