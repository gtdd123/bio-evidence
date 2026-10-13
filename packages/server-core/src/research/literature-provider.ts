import type { ArticleLicense } from '@bio-evidence/research-core'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'

export interface LiteratureRecord {
  provider: 'europe-pmc'
  providerId: string
  identifiers: { doi?: string; pmid?: string; pmcid?: string; providerId?: string }
  title?: string
  authors?: string[]
  year?: number
  abstract?: string
  license: ArticleLicense
  availability: { abstract: boolean; fullText: boolean }
}
export interface LiteratureProvider {
  search(input: { query: string; cursor?: string; pageSize?: number; signal?: AbortSignal }): Promise<{ items: LiteratureRecord[]; nextCursor?: string }>
  record(input: { providerId: string; signal?: AbortSignal }): Promise<LiteratureRecord>
  openText(input: { pmcid: string; signal?: AbortSignal }): Promise<Uint8Array>
}
export class LiteratureProviderError extends Error {
  constructor(readonly reason: 'invalid' | 'rate-limited' | 'timeout' | 'unavailable' | 'budget' | 'cancelled', readonly retryAfterSeconds?: number) {
    super('Public literature request failed.'); this.name = 'LiteratureProviderError'
  }
}
export interface EuropePmcProviderOptions {
  fetch?: typeof fetch
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  maxBytes?: number
  timeoutMs?: number
}
export class EuropePmcProvider implements LiteratureProvider {
  private readonly maxBytes: number
  private readonly timeoutMs: number
  constructor(private readonly options: EuropePmcProviderOptions = {}) {
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024; this.timeoutMs = options.timeoutMs ?? 30000
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 10 * 1024 * 1024 || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000) throw new LiteratureProviderError('invalid')
  }
  private async bytes(url: URL, accept: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) throw new LiteratureProviderError('cancelled')
    const controller = new AbortController()
    const cancel = () => controller.abort(new LiteratureProviderError('cancelled'))
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => controller.abort(new LiteratureProviderError('timeout')), this.timeoutMs)
    let onAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([cancelled, (async () => {
        // IPv4-only transport: every returned address must be globally routable.
        const addresses = await (this.options.resolve ?? (host => lookup(host, { all: true, family: 4 })))(url.hostname)
        if (!addresses.length || addresses.some(entry => entry.family !== 4 || !publicV4(entry.address))) throw new LiteratureProviderError('unavailable')
        controller.signal.throwIfAborted()
        if (this.options.fetch) {
          const response = await this.options.fetch(url, { redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Accept: accept } })
          checkStatus(response.status, response.headers.get('retry-after'))
          const reader = response.body?.getReader(); if (!reader) throw new LiteratureProviderError('unavailable')
          const stop = () => { void reader.cancel().catch(() => {}) }
          controller.signal.addEventListener('abort', stop, { once: true })
          const chunks: Uint8Array[] = []; let size = 0
          try {
            for (;;) {
              controller.signal.throwIfAborted()
              const item = await reader.read(); if (item.done) break
              size += item.value.byteLength
              if (size > this.maxBytes) throw new LiteratureProviderError('budget')
              chunks.push(item.value)
            }
            return Buffer.concat(chunks)
          } finally { controller.signal.removeEventListener('abort', stop); await reader.cancel().catch(() => {}) }
        }
        return await new Promise<Uint8Array>((resolve, reject) => {
          // Pin the validated address on the actual socket, retaining hostname TLS verification.
          const req = request(url, { method: 'GET', agent: false, signal: controller.signal, headers: { Accept: accept },
            lookup: (_host, options, callback) => options.all ? callback(null, [addresses[0]!]) : callback(null, addresses[0]!.address, 4),
          }, response => {
            try { checkStatus(response.statusCode ?? 0, String(response.headers['retry-after'] ?? '')) }
            catch (error) { response.destroy(); req.destroy(); reject(error); return }
            const chunks: Buffer[] = []; let size = 0
            response.on('data', (chunk: Buffer) => {
              size += chunk.length
              if (size > this.maxBytes) { reject(new LiteratureProviderError('budget')); response.destroy(); req.destroy(); return }
              chunks.push(chunk)
            })
            response.on('end', () => resolve(Buffer.concat(chunks)))
            response.on('error', reject); response.on('aborted', () => reject(new LiteratureProviderError('unavailable')))
          })
          req.on('error', reject); req.end()
        })
      })()])
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      if (error instanceof LiteratureProviderError) throw error
      throw new LiteratureProviderError('unavailable')
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    }
  }
  async search(input: Parameters<LiteratureProvider['search']>[0]): ReturnType<LiteratureProvider['search']> {
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2000 || /[\x00-\x1f]/.test(input.query) || (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 2000)) || !Number.isInteger(input.pageSize ?? 25) || (input.pageSize ?? 25) < 1 || (input.pageSize ?? 25) > 50) throw new LiteratureProviderError('invalid')
    const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search')
    url.search = new URLSearchParams({ query: input.query, resultType: 'core', format: 'json', cursorMark: input.cursor ?? '*', pageSize: String(input.pageSize ?? 25) }).toString()
    let envelope: Record<string, unknown>
    try { envelope = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.bytes(url, 'application/json', input.signal)))) }
    catch (error) { if (error instanceof LiteratureProviderError) throw error; throw new LiteratureProviderError('unavailable') }
    const records = array(object(envelope.resultList).result)
    if (records.length > (input.pageSize ?? 25)) throw new LiteratureProviderError('unavailable')
    const items = records.map(recordMetadata)
    const nextCursor = textField(envelope, 'nextCursorMark', 2000)
    return { items, ...(items.length && nextCursor && nextCursor !== (input.cursor ?? '*') ? { nextCursor } : {}) }
  }
  async record(input: Parameters<LiteratureProvider['record']>[0]): ReturnType<LiteratureProvider['record']> {
    if (!/^[A-Z][A-Z0-9_-]{0,15}:[A-Za-z0-9_.-]{1,128}$/.test(input.providerId)) throw new LiteratureProviderError('invalid')
    const [source, id] = input.providerId.split(':')
    const result = await this.search({ query: `EXT_ID:${id} AND SRC:${source}`, pageSize: 1, signal: input.signal })
    const item = result.items.find(item => item.providerId === input.providerId)
    if (!item) throw new LiteratureProviderError('unavailable')
    return item
  }
  async openText(input: Parameters<LiteratureProvider['openText']>[0]): ReturnType<LiteratureProvider['openText']> {
    if (!/^PMC[1-9]\d{0,96}$/.test(input.pmcid)) throw new LiteratureProviderError('invalid')
    return this.bytes(new URL(`https://www.ebi.ac.uk/europepmc/webservices/rest/${input.pmcid}/fullTextXML`), 'application/xml', input.signal)
  }
}

function publicV4(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a! >= 224 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 100 && b! >= 64 && b! <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113)
}
function checkStatus(status: number, retry: string | null): void {
  if (status === 429) throw new LiteratureProviderError('rate-limited', retry && /^\d+$/.test(retry) ? Math.min(3600, Math.max(1, Number(retry))) : undefined)
  if (status !== 200) throw new LiteratureProviderError('unavailable')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LiteratureProviderError('unavailable')
  return value as Record<string, unknown>
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new LiteratureProviderError('unavailable')
  return value
}
function textField(data: Record<string, unknown>, field: string, limit: number): string | undefined {
  const value = data[field]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new LiteratureProviderError('unavailable')
  return value
}
function recordMetadata(value: unknown): LiteratureRecord {
  const data = object(value), id = textField(data, 'id', 200), source = textField(data, 'source', 10)
  if (!id || !source) throw new LiteratureProviderError('unavailable')
  const providerId = `${source}:${id}`, title = textField(data, 'title', 2000), abstract = textField(data, 'abstractText', 1000000)
  const identifiers: LiteratureRecord['identifiers'] = { providerId }
  for (const field of ['doi', 'pmid', 'pmcid'] as const) {
    const value = textField(data, field, field === 'doi' ? 1000 : 100)
    if (value) identifiers[field] = value
  }
  let year: number | undefined
  if (data.pubYear !== undefined && data.pubYear !== null && data.pubYear !== '') {
    if (typeof data.pubYear !== 'number' && !(typeof data.pubYear === 'string' && /^\d{1,4}$/.test(data.pubYear))) throw new LiteratureProviderError('unavailable')
    year = Number(data.pubYear)
    if (!Number.isInteger(year) || year < 0 || year > 9999) throw new LiteratureProviderError('unavailable')
  }
  let authors: string[] | undefined
  if (data.authorList !== undefined) {
    const entries = array(object(data.authorList).author)
    if (entries.length > 1000) throw new LiteratureProviderError('unavailable')
    const names = entries.flatMap(author => { const name = textField(object(author), 'fullName', 500); return name ? [name] : [] })
    if (names.length) authors = names
  }
  const license = textField(data, 'license', 500)
  return { provider: 'europe-pmc', providerId, identifiers, ...(title ? { title } : {}), ...(abstract ? { abstract } : {}), ...(year === undefined ? {} : { year }), ...(authors ? { authors } : {}),
    license: license ? { status: 'known', identifier: license, redistribution: 'unknown' } : { status: 'unknown' },
    availability: { abstract: Boolean(abstract?.trim()), fullText: Boolean(identifiers.pmcid && data.isOpenAccess === 'Y') } }
}
