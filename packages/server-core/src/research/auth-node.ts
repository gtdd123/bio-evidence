import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import type { UserAuthProvider } from '../transport/types'
import { AuthBoundary, actorFromHeaders, createBioAuthHandler, type AuthNetwork } from './auth-http'
import { BioAuthService } from './auth-service'

export function incomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (let index = 0; index < request.rawHeaders.length; index += 2) headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!)
  return headers
}
export function authNetwork(request: IncomingMessage): AuthNetwork {
  return { peerAddress: request.socket.remoteAddress ?? '', secure: !!(request.socket as TLSSocket).encrypted }
}
export function createBioUserAuthProvider(auth: BioAuthService, boundary: AuthBoundary): UserAuthProvider {
  return {
    allowsUpgrade(request) {
      const headers = incomingHeaders(request)
      const hasCookie = (headers.get('cookie') ?? '').split(';').some(pair => pair.trim().startsWith(boundary.cookieName + '='))
      return boundary.allows(headers, authNetwork(request), hasCookie)
    },
    async authenticate(request, token) {
      const headers = incomingHeaders(request)
      if (!this.allowsUpgrade(request)) return null
      if (token !== undefined) {
        const hasCookie = (headers.get('cookie') ?? '').split(';').some(pair => pair.trim().startsWith(boundary.cookieName + '='))
        if (hasCookie || headers.has('authorization')) return null
        return auth.authenticate(token)
      }
      return actorFromHeaders(auth, boundary, headers)
    },
    resolveActor: id => auth.resolveActor(id),
  }
}

function boundedBody(request: IncomingMessage, deadlineMs: number): Promise<Buffer | 'too-large' | 'invalid'> {
  request.setTimeout(10000, () => request.destroy())
  const length = request.headers['content-length']
  if (length && (!/^\d+$/.test(length) || Number(length) > 4096)) { request.resume(); return Promise.resolve('too-large') }
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0, settled = false
    let deadline: ReturnType<typeof setTimeout>
    const finish = (value: Buffer | 'too-large' | 'invalid') => {
      if (!settled) { settled = true; clearTimeout(deadline); chunks.length = 0; resolve(value) }
    }
    deadline = setTimeout(() => { finish('invalid'); request.resume() }, deadlineMs)
    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > 4096) { chunks.length = 0; finish('too-large'); return }
      chunks.push(chunk)
    })
    request.once('end', () => finish(Buffer.concat(chunks)))
    request.once('aborted', () => finish('invalid'))
    request.once('error', () => finish('invalid'))
  })
}
export function createBioAuthNodeAdapter(auth: BioAuthService, boundary: AuthBoundary, options: { bodyDeadlineMs?: number } = {}): (request: IncomingMessage, response: ServerResponse) => void {
  const deadlineMs = options.bodyDeadlineMs ?? 10000
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10000) throw Error('Invalid authentication body deadline')
  const handler = createBioAuthHandler(auth, boundary)
  let reading = 0
  return (request, response) => {
    const send = async (result: Response) => {
      const headers: Record<string, string> = {}
      result.headers.forEach((value, name) => { headers[name] = value })
      response.writeHead(result.status, headers); response.end(await result.text())
    }
    const failure = (status: number, error: string) => Response.json({ error }, { status,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' } })
    void (async () => {
      const headers = incomingHeaders(request), network = authNetwork(request)
      if (!boundary.allows(headers, network)) { request.resume(); await send(failure(403, 'BIO_ACCESS_DENIED')); return }
      const target = request.url ?? '/'
      if (!target.startsWith('/') || target.startsWith('//') || target.length > 2048) { request.resume(); await send(failure(400, 'BIO_INPUT_INVALID')); return }
      const method = request.method ?? 'GET'
      const url = new URL(target, boundary.publicOrigin), path = url.pathname
      if (!['/api/auth/login', '/api/auth/token', '/api/auth/logout', '/api/auth/session'].includes(path)) {
        request.resume(); await send(failure(404, 'NOT_FOUND')); return
      }
      if (method !== (path === '/api/auth/session' ? 'GET' : 'POST')) { request.resume(); await send(failure(405, 'METHOD_NOT_ALLOWED')); return }
      if (method === 'GET' && (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) > 0)) {
        request.resume(); await send(failure(400, 'BIO_INPUT_INVALID')); return
      }
      let body: Buffer | 'too-large' | 'invalid' | undefined
      if (method !== 'GET') {
        if (reading >= 16) { request.resume(); await send(failure(429, 'AUTH_RATE_LIMITED')); return }
        reading++
        try { body = await boundedBody(request, deadlineMs) } finally { reading-- }
      }
      if (body === 'too-large' || body === 'invalid') { await send(failure(body === 'too-large' ? 413 : 400, 'BIO_INPUT_INVALID')); return }
      const result = await handler(new Request(url.href, { method, headers, body }), network)
      await send(result)
    })().catch(() => {
      if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end('{"error":"BIO_STORAGE_UNAVAILABLE"}')
    })
  }
}
