import { z } from 'zod'
import { DocumentIngestResultSchema, DocumentFailureSchema, ImportPdfRequestSchema, ResearchError, BIO_ERROR_MESSAGES } from '@bio-evidence/research-core'
import type { BioPdfImport } from '../shared/bio-api'
export const BioPublicAccountSchema = z.strictObject({ id: z.string().min(1).max(200), username: z.string().min(3).max(64), administrator: z.boolean() })
export const BioCurrentAccountSchema = z.strictObject({ account: BioPublicAccountSchema, sessionBinding: z.string().min(1).max(64) })
function httpFailure(response: Response, raw: unknown): never {
  const code = raw && typeof raw === 'object' && Object.keys(raw).length === 1 ? (raw as { error?: unknown }).error : undefined
  if (typeof code === 'string' && Object.hasOwn(BIO_ERROR_MESSAGES, code)) throw new ResearchError(code as keyof typeof BIO_ERROR_MESSAGES)
  throw new ResearchError(response.status === 401 || response.status === 403 ? 'BIO_ACCESS_DENIED' : 'BIO_STORAGE_UNAVAILABLE')
}
async function readBody(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new ResearchError('BIO_INPUT_INVALID') }; chunks.push(value) }
    const bytes = new Uint8Array(size); let offset = 0
    for (const part of chunks) { bytes.set(part, offset); offset += part.length }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally { reader.releaseLock() }
}
export async function readBioJson(response: Response, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
  const raw = await readBody(response, maxBytes)
  if (!response.ok) httpFailure(response, raw)
  return raw
}
export async function uploadBioPdf(origin: string, input: BioPdfImport, bytes: Uint8Array, headers: Record<string, string> = {}) {
  const request = ImportPdfRequestSchema.parse(input)
  const params = new URLSearchParams({ expectedRevision: String(request.expectedRevision), declaredPublic: String(request.declaredPublic) })
  const result = await fetch(`${origin}/api/research/sessions/${encodeURIComponent(request.sessionId)}/pdf?${params}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/pdf' }, body: new Blob([Uint8Array.from(bytes)]),
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(40000),
  })
  const raw = await readBody(result, 32 * 1024 * 1024)
  if (!result.ok) { const failure = DocumentFailureSchema.safeParse(raw); if (failure.success) return failure.data; httpFailure(result, raw) }
  return DocumentIngestResultSchema.parse(raw)
}
