// Bun startup component; SQLite/auth service stay outside Node/Electron exports.
import { WsRpcServer, type WsRpcTlsOptions } from '../transport/server'
import { BioAuthService } from './auth-service'
import { AuthBoundary } from './auth-http'
import { createBioAuthNodeAdapter, createBioUserAuthProvider } from './auth-node'
import type { ResearchRepository } from '@bio-evidence/research-core'
export interface BioAuthorityServerOptions {
  host?: string; port?: number; publicOrigin?: string; trustedProxies?: readonly string[]; tls?: WsRpcTlsOptions
}
export async function createBioAuthorityServer(repository: ResearchRepository, options: BioAuthorityServerOptions = {}) {
  const host = options.host ?? '127.0.0.1', port = options.port ?? 9100
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid service port')
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host)
  if (!local && (!options.tls || !options.publicOrigin)) throw Error('Remote authority requires TLS and an explicit public origin')
  const auth = await BioAuthService.create(repository)
  let server: WsRpcServer | undefined
  const hostname = host === '::1' ? '[::1]' : host
  const boundary = new AuthBoundary(options.publicOrigin ?? (() => `${options.tls ? 'https' : 'http'}://${hostname}:${server?.port || port}`), options.trustedProxies)
  if (options.tls && !boundary.publicOrigin.startsWith('https:') || !options.tls && boundary.publicOrigin.startsWith('https:') && !options.trustedProxies?.length) {
    throw Error('Public origin must match TLS or an explicitly trusted TLS proxy')
  }
  server = new WsRpcServer({ host, port, tls: options.tls, userAuth: createBioUserAuthProvider(auth, boundary),
    httpHandler: createBioAuthNodeAdapter(auth, boundary), serverId: 'bioevidence' })
  // Start with no legacy handlers. T07 registers and guards approved research
  // channels; the shared Craft token and old login/OAuth routes are unavailable.
  return { server, auth, boundary }
}
