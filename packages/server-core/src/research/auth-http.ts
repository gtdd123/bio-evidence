import { BioAuthService } from './auth-service'
import { z } from 'zod'
import { isIP } from 'node:net'
import { RateLimiter } from '../webui/auth'
import type { Actor } from '@bio-evidence/research-core'
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const normalizeIp = (ip: string) => ip.startsWith('::ffff:') ? ip.slice(7) : ip
const Credentials = z.strictObject({ username: z.string().min(3).max(64), password: z.string().min(1).max(1024) })
const MAX_BODY = 4096
export interface AuthNetwork { peerAddress: string; secure: boolean }
export class AuthBoundary {
  constructor(private readonly origin: string | (() => string), private readonly trustedProxies: readonly string[] = []) {
    this.publicOrigin
    if (trustedProxies.some(ip => !isIP(normalizeIp(ip)))) throw Error('Invalid trusted proxy configuration')
  }
  get publicOrigin(): string {
    const value = typeof this.origin === 'string' ? this.origin : this.origin()
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) throw Error('TLS required for remote authentication')
    return url.origin
  }
  get cookieName(): string { return this.publicOrigin.startsWith('https:') ? '__Host-bio_session' : 'bio_session' }
  cookie(token: string | null): string {
    return `${this.cookieName}=${token ?? ''}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 86400 : 0}` +
      (this.publicOrigin.startsWith('https:') ? '; Secure' : '')
  }
  allows(headers: Headers, network: AuthNetwork, browserMutation = false, desktop = false): boolean {
    const expected = new URL(this.publicOrigin)
    if (headers.get('host')?.toLowerCase() !== expected.host.toLowerCase()) return false
    if (expected.protocol === 'http:' && !['127.0.0.1', '::1'].includes(normalizeIp(network.peerAddress))) return false
    const proxy = this.trustedProxies.some(ip => normalizeIp(ip) === normalizeIp(network.peerAddress))
    const forwarded = ['forwarded', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-for'].some(name => headers.has(name))
    if (forwarded && !proxy || headers.has('forwarded')) return false
    if (headers.has('x-forwarded-host') && headers.get('x-forwarded-host') !== expected.host) return false
    if (headers.has('x-forwarded-proto') && headers.get('x-forwarded-proto') !== expected.protocol.slice(0, -1)) return false
    if (expected.protocol === 'https:' && !network.secure && !(proxy && headers.get('x-forwarded-proto') === 'https')) return false
    const requestOrigin = headers.get('origin')
    if (desktop) return !requestOrigin && !headers.has('sec-fetch-site')
    if (requestOrigin && requestOrigin !== expected.origin) return false
    if (browserMutation && requestOrigin !== expected.origin) return false
    return true
  }
}
export function actorFromHeaders(auth: BioAuthService, boundary: AuthBoundary, headers: Headers): Actor | null {
  const authorization = headers.get('authorization')
  const cookies = (headers.get('cookie') ?? '').split(';').map(pair => pair.trim()).filter(pair => pair.startsWith(`${boundary.cookieName}=`))
  if (authorization) {
    if (cookies.length) return null
    const bearer = /^Bearer ([A-Za-z0-9._-]+)$/i.exec(authorization)
    const actor = bearer ? auth.authenticate(bearer[1]!) : null
    return actor && (!headers.has('x-bio-session-binding') || headers.get('x-bio-session-binding') === actor.authSessionId) ? actor : null
  }
  if (cookies.length !== 1) return null
  const actor = auth.authenticate(cookies[0]!.slice(boundary.cookieName.length + 1))
  return actor && (!headers.has('x-bio-session-binding') || headers.get('x-bio-session-binding') === actor.authSessionId) ? actor : null
}
export async function boundedCredentials(request: Request): Promise<z.infer<typeof Credentials>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw Error('INVALID')
  const length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw Error('TOO_LARGE')
  const reader = request.body?.getReader()
  if (!reader) throw Error('INVALID')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break
      size += value.byteLength
      if (size > MAX_BODY) { await reader.cancel(); throw Error('TOO_LARGE') }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return Credentials.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch (error) { if ((error as Error).message === 'TOO_LARGE') throw error; throw Error('INVALID') }
  finally { reader.releaseLock() }
}
export function createBioAuthHandler(auth: BioAuthService, boundary: AuthBoundary) {
  const limiter = new RateLimiter(10, 60_000, 100)
  let verifying = 0
  const result = (body: unknown, status = 200, cookie?: string) => Response.json(body, { status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(cookie ? { 'Set-Cookie': cookie } : {}) } })
  return async (request: Request, network: AuthNetwork): Promise<Response> => {
    let logout = false
    try {
      const path = new URL(request.url).pathname
      const login = path === '/api/auth/login', desktop = path === '/api/auth/token'
      logout = path === '/api/auth/logout'
      const status = path === '/api/auth/session'
      if (!login && !desktop && !logout && !status) return result({ error: 'NOT_FOUND' }, 404)
      if (request.method !== (status ? 'GET' : 'POST')) return result({ error: 'METHOD_NOT_ALLOWED' }, 405)
      const bearerLogout = logout && request.headers.has('authorization')
      if (!boundary.allows(request.headers, network, login || logout && !bearerLogout, desktop || bearerLogout)) return result({ error: 'BIO_ACCESS_DENIED' }, 403)
      if (login || desktop) {
        limiter.cleanup()
        if (!limiter.check(normalizeIp(network.peerAddress))) return result({ error: 'AUTH_RATE_LIMITED' }, 429)
        let input: z.infer<typeof Credentials>
        try { input = await boundedCredentials(request) } catch (error) {
          return result({ error: 'BIO_INPUT_INVALID' }, (error as Error).message === 'TOO_LARGE' ? 413 : 400)
        }
        if (verifying >= 4) return result({ error: 'AUTH_RATE_LIMITED' }, 429)
        verifying++
        try {
          const session = await auth.login(input.username, input.password)
          return desktop ? result({ token: session.token, account: session.account, expiresAt: session.expiresAt }) :
            result({ account: session.account, expiresAt: session.expiresAt, sessionBinding: session.actor.authSessionId }, 200, boundary.cookie(session.token))
        } catch { return result({ error: 'AUTH_FAILED' }, 401) } finally { verifying-- }
      }
      const actor = actorFromHeaders(auth, boundary, request.headers)
      const unboundLogout = logout && !request.headers.has('x-bio-session-binding')
      if (!actor) return result({ error: 'AUTH_FAILED' }, 401, unboundLogout ? boundary.cookie(null) : undefined)
      // A bound logout cannot clear a newer cookie set by another browser tab,
      // even when this successful response arrives after that tab's login.
      if (logout) { auth.logout(actor); return result({ success: true }, 200, unboundLogout ? boundary.cookie(null) : undefined) }
      return result({ account: auth.currentAccount(actor), sessionBinding: actor.authSessionId })
    } catch (error) {
      if ((error as { code?: string }).code === 'AUTH_FAILED') return result({ error: 'AUTH_FAILED' }, 401, logout && !request.headers.has('x-bio-session-binding') ? boundary.cookie(null) : undefined)
      return result({ error: 'BIO_STORAGE_UNAVAILABLE' }, 503)
    }
  }
}
