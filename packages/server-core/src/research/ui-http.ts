import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute, sep, extname } from 'node:path'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { AuthBoundary, actorFromHeaders } from './auth-http'
import { incomingHeaders, authNetwork } from './auth-node'
import type { BioAuthService } from './auth-service'

const Manifest = z.strictObject({ product: z.literal('BioEvidence'), version: z.literal(1), files: z.array(z.strictObject({
  path: z.string().regex(/^(?:index\.html|assets\/[A-Za-z0-9_/-]+\.(?:js|css|woff2?|svg|png|ico))$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
})).min(1).max(1000) })
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' }
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
/** A trusted host supplies an asset root. Neither RPC nor service.json can select it. */
export function createBioUiHttpAdapter(auth: BioAuthService, boundary: AuthBoundary, assetRoot?: string) {
  const assets = new Map<string, { body: Buffer; type: string }>()
  if (assetRoot) {
    const root = realpathSync.native(assetRoot)
    const owned = (name: string) => {
      const path = realpathSync.native(resolve(root, name)), offset = relative(root, path)
      if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset) || !statSync(path).isFile()) throw Error('Invalid UI asset boundary')
      return path
    }
    const manifestPath = owned('bio-ui.json')
    if (statSync(manifestPath).size > 256 * 1024) throw Error('UI manifest budget')
    const manifest = Manifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
    let total = 0
    for (const file of manifest.files) {
      if (assets.has('/' + file.path)) throw Error('Duplicate UI asset')
      const path = owned(file.path), size = statSync(path).size
      if (size > 20 * 1024 * 1024 || (total += size) > 50 * 1024 * 1024) throw Error('UI asset budget')
      const body = readFileSync(path)
      if (body.length !== size || createHash('sha256').update(body).digest('hex') !== file.sha256) throw Error('UI asset integrity')
      if (file.path === 'index.html' && !body.toString('utf8').includes('<meta name="bio-evidence" content="1">')) throw Error('Invalid product UI')
      assets.set('/' + file.path, { body, type: types[extname(file.path)]! })
    }
    if (!assets.has('/index.html')) throw Error('Missing product UI')
  }
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const target = request.url ?? '/', isConfig = target === '/api/config'
    // Never normalize encoded/traversing names into allowed files.
    const key = target === '/' || target === '/login' ? '/index.html' : target
    const asset = assets.get(key)
    if (!isConfig && !asset) return false
    const send = (status: number, body: string | Buffer, type = 'application/json; charset=utf-8') => {
      request.resume()
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp.replace("connect-src 'self'", `connect-src 'self' ${boundary.publicOrigin.replace(/^http/, 'ws')}`),
        'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Length': Buffer.byteLength(body) })
      response.end(request.method === 'HEAD' ? undefined : body)
    }
    try {
      const headers = incomingHeaders(request)
      if (!boundary.allows(headers, authNetwork(request))) { send(403, '{"error":"BIO_ACCESS_DENIED"}'); return true }
      if (request.method !== 'GET' && request.method !== 'HEAD') { send(405, '{"error":"METHOD_NOT_ALLOWED"}'); return true }
      if (headers.has('transfer-encoding') || Number(headers.get('content-length') ?? 0) !== 0) { send(400, '{"error":"BIO_INPUT_INVALID"}'); return true }
      if (isConfig) {
        const actor = actorFromHeaders(auth, boundary, headers)
        if (!actor) { send(401, '{"error":"AUTH_FAILED"}'); return true }
        auth.currentAccount(actor)
        send(200, JSON.stringify({ product: 'BioEvidence', protocolVersion: 1, wsUrl: boundary.publicOrigin.replace(/^http/, 'ws') }))
      } else send(200, asset!.body, asset!.type)
    } catch { if (!response.headersSent) send(503, '{"error":"BIO_STORAGE_UNAVAILABLE"}'); else response.end() }
    return true
  }
}
