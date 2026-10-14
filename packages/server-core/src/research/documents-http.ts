import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BioAuthService } from './auth-service'
import type { AuthBoundary } from './auth-http'
import type { SourceSnapshotService } from './source-snapshots'
import { ResearchError, ImportPdfRequestSchema, parseContract } from '@bio-evidence/research-core'
import { incomingHeaders, authNetwork } from './auth-node'
import { actorFromHeaders } from './auth-http'
export function createDocumentsHttpAdapter(snapshots: SourceSnapshotService, auth: BioAuthService, boundary: AuthBoundary) {
  const active = new Map<AbortController, IncomingMessage>(), pending = new Set<Promise<void>>()
  let closed = false
  const adapter = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (!request.url?.startsWith('/api/research/')) return false
    const reply = (status: number, value: unknown) => {
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Connection': 'close' })
      response.end(JSON.stringify(value))
    }
    const work = (async () => {
      let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
      const abort = () => controller?.abort()
      try {
        if (closed) { reply(503, { status: 'unavailable' }); return }
        if (request.method !== 'POST') { reply(405, { error: 'METHOD_NOT_ALLOWED' }); return }
        const headers = incomingHeaders(request), desktop = Boolean(headers.get('authorization'))
        if (!boundary.allows(headers, authNetwork(request), true, desktop)) { reply(403, { error: 'BIO_ACCESS_DENIED' }); return }
        const actor = actorFromHeaders(auth, boundary, headers)
        if (!actor) { reply(401, { error: 'AUTH_FAILED' }); return }
        const refresh = () => { const current = auth.resolveActor(actor.authSessionId); if (!current || current.userId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED'); return current }
        if (request.url!.length > 4096 || headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/pdf') throw new ResearchError('BIO_INPUT_INVALID')
        const url = new URL(request.url!, boundary.publicOrigin), match = /^\/api\/research\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/pdf$/.exec(url.pathname)
        if (!match) throw new ResearchError('BIO_INPUT_INVALID')
        const params: Record<string, unknown> = { sessionId: match[1] }
        for (const [key, value] of url.searchParams) {
          if (Object.hasOwn(params, key)) throw new ResearchError('BIO_INPUT_INVALID')
          params[key] = key === 'expectedRevision' ? (/^[1-9]\d*$/.test(value) ? Number(value) : NaN) : key === 'declaredPublic' ? (value === 'true' ? true : value === 'false' ? false : value) : value
        }
        const input = parseContract(ImportPdfRequestSchema, params)
        snapshots.authorizeSession(refresh(), input.sessionId)
        const length = headers.get('content-length')
        if (length && (!/^\d+$/.test(length) || Number(length) > snapshots.limits.pdfMaxBytes)) { reply(413, { status: 'budget' }); return }
        if (active.size) { reply(503, { status: 'busy' }); return }
        controller = new AbortController(); active.set(controller, request)
        request.once('aborted', abort); response.once('close', abort)
        timer = setTimeout(() => { controller!.abort(); request.destroy() }, snapshots.limits.timeoutMs)
        const chunks: Uint8Array[] = []; let size = 0
        for await (const chunk of request) {
          if (controller.signal.aborted) return
          snapshots.authorizeSession(refresh(), input.sessionId)
          size += chunk.length
          if (size > snapshots.limits.pdfMaxBytes) { reply(413, { status: 'budget' }); response.once('finish', () => request.destroy()); return }
          chunks.push(chunk)
        }
        clearTimeout(timer); timer = undefined
        if (controller.signal.aborted) return
        const result = await snapshots.importPdf(refresh(), { ...input, bytes: Buffer.concat(chunks) }, controller.signal)
        snapshots.validateResult(refresh(), input.sessionId, result)
        if (result.status === 'ok' && result.source.policy !== (input.declaredPublic ? 'public' : 'restricted')) throw new ResearchError('BIO_ACCESS_DENIED')
        reply(result.status === 'ok' ? 200 : result.status === 'budget' ? 413 : result.status === 'timeout' ? 504 : result.status === 'cancelled' ? 408 : result.status === 'busy' || result.status === 'unavailable' ? 503 : 422, result)
      } catch (error) {
        const code = error instanceof ResearchError ? error.code : 'BIO_STORAGE_UNAVAILABLE'
        reply(code === 'BIO_ACCESS_DENIED' ? 403 : code === 'BIO_INPUT_INVALID' ? 400 : code === 'BIO_REVISION_CONFLICT' ? 409 : code === 'BIO_POLICY_DENIED' ? 403 : 503, { error: code })
      } finally {
        if (timer) clearTimeout(timer)
        request.removeListener('aborted', abort); response.removeListener('close', abort)
        if (controller) active.delete(controller)
      }
    })()
    pending.add(work); void work.finally(() => pending.delete(work))
    return true
  }
  return Object.assign(adapter, { close: async () => { closed = true; for (const [controller, request] of active) { controller.abort(); request.destroy() }; await Promise.allSettled([...pending]) } })
}
