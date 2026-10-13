import type { IncomingMessage, ServerResponse } from 'node:http'
import { RESEARCH_CHANNELS as R, ResearchError, parseContract, MaterialFileRequestSchema, MaterialImageRequestSchema, type ResearchRequestChannel } from '@bio-evidence/research-core'
import { incomingHeaders, authNetwork } from './auth-node'
import { actorFromHeaders, type AuthBoundary } from './auth-http'
import type { BioAuthService } from './auth-service'
import type { registerResearchRpcProfile } from './rpc-profile'
import type { MaterialsService } from './materials-service'
import type { MaterialPreviewService } from './material-preview'
function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const clear = () => { response.removeListener('drain', drain); response.removeListener('close', close) }
    const drain = () => { clear(); resolve() }, close = () => { clear(); reject(new ResearchError('BIO_STORAGE_UNAVAILABLE')) }
    response.once('drain', drain); response.once('close', close)
    if (response.destroyed) close()
  })
}
export function createMaterialsHttpAdapter(profile: ReturnType<typeof registerResearchRpcProfile>, auth: BioAuthService, boundary: AuthBoundary,
  files?: { materials: MaterialsService; previews: MaterialPreviewService }) {
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    if (!request.url?.startsWith('/api/materials/')) return false
    const reply = (status: number, value: unknown) => {
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
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
          params[key] = ['generation', 'pageSize', 'frameIndex'].includes(key) ? (/^\d+$/.test(value) ? Number(value) : NaN) : value
        }
        const view = params.view ?? 'root'; delete params.view
        const refresh = () => {
          const current = auth.resolveActor(actor.authSessionId)
          if (!current || current.userId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED')
          return current
        }
        if (view === 'preview' || view === 'image' || view === 'download') {
          if (!files) throw new ResearchError('BIO_ACCESS_DENIED')
          const controller = new AbortController(), aborted = () => controller.abort()
          request.once('aborted', aborted); response.once('close', aborted)
          try {
            if (view === 'download') {
              const input = parseContract(MaterialFileRequestSchema, { ...params, rootId: match[1] })
              const file = await files.materials.openFile(refresh(), input.rootId, input.relativeDir, input.generation, input.fileId)
              try {
                refresh(); await file.verify()
                const name = encodeURIComponent(file.entry.name).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase())
                response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.entry.size,
                  'Content-Disposition': `attachment; filename*=UTF-8''${name}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
                for await (const chunk of file.chunks(controller.signal)) {
                  files.materials.fileEntry(refresh(), input.rootId, input.relativeDir, input.generation, input.fileId)
                  await file.verify()
                  if (!response.write(chunk)) await waitForDrain(response)
                }
                files.materials.fileEntry(refresh(), input.rootId, input.relativeDir, input.generation, input.fileId)
                response.end()
              } finally { await file.close() }
            } else {
              const input = parseContract(MaterialImageRequestSchema, { kind: view === 'image' ? 'metadata' : 'view', ...params, rootId: match[1] })
              if (view === 'preview' && input.kind === 'metadata' || view === 'image' && input.kind !== 'metadata') throw new ResearchError('BIO_INPUT_INVALID')
              const image = await files.previews.preview(refresh(), input.rootId, input.relativeDir, input.generation, input.fileId, input.kind, input.frameIndex, controller.signal)
              files.previews.validateResult(refresh(), input.relativeDir, image)
              if (image.status !== 'ok') { reply(image.status === 'timeout' ? 504 : image.status === 'budget' ? 413 : image.status === 'busy' || image.status === 'unavailable' ? 503 : 422, image); return }
              if (view === 'image') { reply(200, image); return }
              response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.bytes!.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
              for (let offset = 0; offset < image.bytes!.length; offset += 65536) {
                files.previews.validateResult(refresh(), input.relativeDir, image)
                if (!response.write(image.bytes!.subarray(offset, offset + 65536))) await waitForDrain(response)
              }
              files.previews.validateResult(refresh(), input.relativeDir, image); response.end()
            }
          } finally { request.removeListener('aborted', aborted); response.removeListener('close', aborted) }
          return
        }
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
