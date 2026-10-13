import type { IncomingMessage, ServerResponse } from 'node:http'
import { RESEARCH_CHANNELS as R, ResearchError, type ResearchRequestChannel } from '@bio-evidence/research-core'
import { incomingHeaders, authNetwork } from './auth-node'
import { actorFromHeaders, type AuthBoundary } from './auth-http'
import type { BioAuthService } from './auth-service'
import type { registerResearchRpcProfile } from './rpc-profile'
export function createMaterialsHttpAdapter(profile: ReturnType<typeof registerResearchRpcProfile>, auth: BioAuthService, boundary: AuthBoundary) {
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    if (!request.url?.startsWith('/api/materials/')) return false
    const reply = (status: number, value: unknown) => {
      if (response.destroyed) return
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Connection': 'close' })
      response.end(JSON.stringify(value))
    }
    void (async () => {
      try {
        if (request.method !== 'GET') { reply(405, { error: 'METHOD_NOT_ALLOWED' }); return }
        if (request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0' || request.url!.length > 8192) { reply(400, { error: 'INVALID_REQUEST' }); return }
        const headers = incomingHeaders(request)
        if (!boundary.allows(headers, authNetwork(request))) { reply(403, { error: 'ACCESS_DENIED' }); return }
        const actor = actorFromHeaders(auth, boundary, headers)
        if (!actor) { reply(401, { error: 'AUTH_FAILED' }); return }
        const url = new URL(request.url!, boundary.publicOrigin), match = /^\/api\/materials\/([a-zA-Z0-9_-]{1,64})$/.exec(url.pathname)
        if (!match) { reply(400, { error: 'INVALID_REQUEST' }); return }
        const params: Record<string, unknown> = {}
        for (const [key, value] of url.searchParams) {
          if (Object.hasOwn(params, key)) throw new ResearchError('BIO_INPUT_INVALID')
          params[key] = ['generation', 'pageSize'].includes(key) ? (/^\d+$/.test(value) ? Number(value) : NaN) : value
        }
        const view = params.view ?? 'root'; delete params.view
        const channel: ResearchRequestChannel = view === 'root' ? R.GET_MATERIAL : view === 'directory' ? R.LIST_MATERIAL_DIRECTORY :
          view === 'index' ? R.GET_MATERIAL_INDEX : view === 'annotation' ? R.GET_MATERIAL_ANNOTATION : (() => { throw new ResearchError('BIO_INPUT_INVALID') })()
        const result = await profile.dispatch(actor, channel, { ...params, rootId: match[1] }, before => {
          const fresh = auth.resolveActor(before.authSessionId)
          if (!fresh || fresh.userId !== before.userId) throw new ResearchError('BIO_ACCESS_DENIED')
          return fresh
        })
        reply(200, result)
      } catch (error) {
        const code = error instanceof ResearchError ? error.code : 'BIO_STORAGE_UNAVAILABLE'
        reply(code === 'BIO_ACCESS_DENIED' ? 403 : code === 'BIO_INPUT_INVALID' ? 400 : code === 'BIO_REVISION_CONFLICT' ? 409 : 503, { error: code })
      }
    })()
    return true
  }
}
