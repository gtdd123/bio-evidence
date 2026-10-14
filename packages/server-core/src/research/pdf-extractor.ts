import { DocumentBudgetsSchema, type DocumentBudgets, type ParsedDocumentResult } from '@bio-evidence/research-core'
import type { PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api'

// Text extraction accepts only bytes. Auxiliary font/CMap/WASM loaders must not
// turn untrusted PDF content into network or filesystem requests.
class NoExternalResources {
  async fetch(): Promise<never> { throw new Error('External PDF resources are disabled') }
}

async function pageText(page: PDFPageProxy, remainingChars: number, signal?: AbortSignal): Promise<string | null> {
  const reader = page.streamTextContent({ disableNormalization: true }).getReader()
  const parts: string[] = []
  let chars = 0
  let complete = false
  try {
    while (true) {
      if (signal?.aborted) throw new Error('Cancelled')
      const chunk = await reader.read()
      if (signal?.aborted) throw new Error('Cancelled')
      if (chunk.done) { complete = true; break }
      for (const item of (chunk.value as TextContent).items) {
        if (!('str' in item) || !item.str) continue
        const separator = parts.length ? ' ' : ''
        if (item.str.length + separator.length > remainingChars - chars) return null
        if (separator) parts.push(separator)
        parts.push(item.str)
        chars += item.str.length + separator.length
      }
    }
    return parts.join('').trim()
  } finally {
    if (!complete) await reader.cancel(new Error('PDF text extraction stopped')).catch(() => {})
    reader.releaseLock()
  }
}

// Avoid splitting a UTF-16 surrogate pair. Blank-only chunks cannot satisfy the
// evidence block contract, so those unusual pages become explicit gaps.
function textChunks(text: string): string[] | null {
  const chunks: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 200000)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--
    const chunk = text.slice(start, end)
    if (!chunk.trim()) return null
    chunks.push(chunk)
    start = end
  }
  return chunks
}

export async function extractPdf(
  input: Uint8Array,
  budgets?: Partial<DocumentBudgets>,
  signal?: AbortSignal,
): Promise<ParsedDocumentResult> {
  const limits = DocumentBudgetsSchema.parse(budgets ?? {})
  if (signal?.aborted) return { status: 'cancelled' }
  if (input.byteLength > limits.pdfMaxBytes) return { status: 'budget' }
  if (!input.byteLength) return { status: 'invalid' }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (signal?.aborted) return { status: 'cancelled' }
  const task = getDocument({
    data: new Uint8Array(input), verbosity: 0, isEvalSupported: false,
    useWorkerFetch: false, useWasm: false, useSystemFonts: false,
    disableFontFace: true, disableRange: true, disableStream: true,
    disableAutoFetch: true, enableXfa: false, stopAtErrors: true,
    CMapReaderFactory: NoExternalResources, StandardFontDataFactory: NoExternalResources,
    WasmFactory: NoExternalResources,
  })
  const abort = () => { void task.destroy().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const document = await task.promise
    if (signal?.aborted) return { status: 'cancelled' }
    if (document.numPages > limits.pdfMaxPages) return { status: 'budget' }
    const units: Extract<ParsedDocumentResult, { status: 'ok' }>['coverage']['units'] = []
    const blocks: Extract<ParsedDocumentResult, { status: 'ok' }>['blocks'] = []
    let chars = 0
    let budgetExceeded = false
    for (let unit = 1; unit <= document.numPages; unit++) {
      if (signal?.aborted) return { status: 'cancelled' }
      if (budgetExceeded) { units.push({ unit, status: 'failed', reason: 'budget' }); continue }
      let page: PDFPageProxy | undefined
      try {
        page = await document.getPage(unit)
        const text = await pageText(page, limits.maxTextChars - chars, signal)
        if (text === null) {
          budgetExceeded = true
          units.push({ unit, status: 'failed', reason: 'budget' })
        } else if (!text) units.push({ unit, status: 'no-text', reason: 'scan-or-empty' })
        else {
          const chunks = textChunks(text)
          if (!chunks) { units.push({ unit, status: 'unsupported', reason: 'unsupported-content' }); continue }
          units.push({ unit, status: 'read' })
          chunks.forEach((text, index) => blocks.push({ id: `pdf-p${unit}-b${index + 1}`, unit, text, locator: { kind: 'pdf-page', page: unit } }))
          chars += text.length
        }
      } catch {
        if (signal?.aborted) return { status: 'cancelled' }
        units.push({ unit, status: 'failed', reason: 'decode-failed' })
      } finally { page?.cleanup() }
    }
    if (signal?.aborted) return { status: 'cancelled' }
    return { status: 'ok', format: 'pdf', coverage: {
      level: units.every(unit => unit.status === 'read') ? 'full' : 'partial', totalUnits: document.numPages, units,
    }, blocks }
  } catch (error) {
    if (signal?.aborted) return { status: 'cancelled' }
    return { status: error instanceof Error && error.name === 'PasswordException' ? 'encrypted' : 'invalid' }
  } finally {
    signal?.removeEventListener('abort', abort)
    await task.destroy().catch(() => {})
  }
}
