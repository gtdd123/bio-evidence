import { expect, test } from 'bun:test'
import { ParsedDocumentResultSchema } from '@bio-evidence/research-core'
import { extractPdf } from './pdf-extractor'

// Real, self-contained synthetic PDF objects and byte offsets. No external files,
// fonts, experiment materials, or document-generator dependency are involved.
function pdf(pages: string[], options: { unicode?: boolean, encrypted?: boolean, badPage?: number, scans?: number[], activeContent?: boolean } = {}): Uint8Array {
  const objects: string[] = ['', '', '']
  const pageRefs: number[] = []
  objects[2] = options.unicode
    ? '<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>'
    : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  if (options.unicode) {
    objects.push('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 600 /CIDToGIDMap /Identity /FontDescriptor 6 0 R >>')
    const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <0001> <7EC6> <0002> <80DE> <0003> <03B1> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
    objects.push(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`)
    objects.push('<< /Type /FontDescriptor /FontName /Synthetic /Flags 4 /FontBBox [0 -200 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>')
  }
  let imageRef: number | undefined
  if (options.scans?.length) {
    imageRef = objects.length + 1
    objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n\0\0\0\nendstream')
  }
  pages.forEach((text, index) => {
    const pageId = objects.length + 1
    const streamId = pageId + 1
    pageRefs.push(pageId)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Math.max(600, text.length * 15)} 800] /Resources << /Font << /F1 3 0 R >>${imageRef ? ` /XObject << /Img ${imageRef} 0 R >>` : ''} >> /Contents ${streamId} 0 R >>`)
    const content = options.scans?.includes(index + 1) ? 'q 100 0 0 100 0 0 cm /Img Do Q'
      : text ? `BT /F1 12 Tf 30 700 Td ${options.unicode ? `<${text}>` : `(${text.replace(/([\\()])/g, '\\$1')})`} Tj ET` : ''
    objects.push(options.badPage === index + 1
      ? '<< /Length 7 /Filter [/ASCIIHexDecode /FlateDecode] >>\nstream\n789C07>\nendstream'
      : `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  })
  objects[0] = `<< /Type /Catalog /Pages 2 0 R${options.activeContent ? ' /OpenAction << /S /JavaScript /JS (globalThis.__bioPdfActionSentinel = true;) >> /AA << /WC << /S /URI /URI (https://example.invalid/collect) >> >>' : ''} >>`
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  let encryptRef: number | undefined
  if (options.encrypted) {
    encryptRef = objects.length + 1
    objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`)
  }
  let document = '%PDF-1.7\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptRef ? ` /Encrypt ${encryptRef} 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(document))
}

test('PDF extraction preserves page locators and the caller bytes', async () => {
  const input = pdf(['First page', 'Second page'])
  const original = input.slice()
  const result = await extractPdf(input)
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error('Expected parsed synthetic PDF')
  expect(result.coverage).toEqual({ level: 'full', totalUnits: 2, units: [{ unit: 1, status: 'read' }, { unit: 2, status: 'read' }] })
  expect(result.blocks).toEqual([
    { id: 'pdf-p1-b1', unit: 1, text: 'First page', locator: { kind: 'pdf-page', page: 1 } },
    { id: 'pdf-p2-b1', unit: 2, text: 'Second page', locator: { kind: 'pdf-page', page: 2 } },
  ])
  expect(input.byteLength).toBe(original.byteLength)
  expect(Buffer.from(input).equals(Buffer.from(original))).toBe(true)
  expect(ParsedDocumentResultSchema.safeParse(result).success).toBe(true)
}, 30000)

test('PDF image-only and mixed pages retain each unread page', async () => {
  const scanned = await extractPdf(pdf(['', ''], { scans: [1, 2] }))
  expect(scanned.status).toBe('ok')
  if (scanned.status !== 'ok') throw new Error('Expected image-only PDF')
  expect(scanned.coverage).toEqual({ level: 'partial', totalUnits: 2, units: [
    { unit: 1, status: 'no-text', reason: 'scan-or-empty' }, { unit: 2, status: 'no-text', reason: 'scan-or-empty' },
  ] })
  expect(scanned.blocks).toEqual([])
  const mixed = await extractPdf(pdf(['Before', '', 'After'], { scans: [2] }))
  expect(mixed.status).toBe('ok')
  if (mixed.status !== 'ok') throw new Error('Expected mixed PDF')
  expect(mixed.coverage.level).toBe('partial')
  expect(mixed.blocks.map(block => block.locator)).toEqual([{ kind: 'pdf-page', page: 1 }, { kind: 'pdf-page', page: 3 }])
  expect(mixed.blocks.map(block => block.text)).toEqual(['Before', 'After'])
})

test('A PDF containing abstract text still has PDF page locators', async () => {
  const result = await extractPdf(pdf(['Abstract: synthetic observations.']))
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error('Expected abstract PDF')
  expect(result.coverage.level).toBe('full')
  expect(result.blocks[0]?.locator).toEqual({ kind: 'pdf-page', page: 1 })
})

test('PDF Unicode mappings retain text and UTF-16 offsets', async () => {
  const result = await extractPdf(pdf(['000100020003'], { unicode: true }))
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error('Expected Unicode PDF')
  expect(result.blocks[0]?.text).toBe('细胞α')
  expect(result.blocks[0]?.text.slice(1, 3)).toBe('胞α')
  expect(result.blocks[0]?.locator).toEqual({ kind: 'pdf-page', page: 1 })
})

test('Encrypted and structurally invalid PDF have explicit failures', async () => {
  expect(await extractPdf(pdf(['Secret'], { encrypted: true }))).toEqual({ status: 'encrypted' })
  expect(await extractPdf(new Uint8Array())).toEqual({ status: 'invalid' })
  expect(await extractPdf(new TextEncoder().encode('%PDF-1.7\nnot a document'))).toEqual({ status: 'invalid' })
})

test('PDF byte and page limits accept exact bounds and reject exceeded limits', async () => {
  const input = pdf(['One', 'Two'])
  expect((await extractPdf(input, { pdfMaxBytes: input.byteLength, pdfMaxPages: 2 })).status).toBe('ok')
  expect(await extractPdf(input, { pdfMaxBytes: input.byteLength - 1 })).toEqual({ status: 'budget' })
  expect(await extractPdf(input, { pdfMaxPages: 1 })).toEqual({ status: 'budget' })
})

test('PDF text budget preserves prior pages and marks remaining pages unread', async () => {
  const input = pdf(['12345', '123456', 'Third'])
  const result = await extractPdf(input, { maxTextChars: 10 })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error('Expected partial budget coverage')
  expect(result.coverage).toEqual({ level: 'partial', totalUnits: 3, units: [
    { unit: 1, status: 'read' }, { unit: 2, status: 'failed', reason: 'budget' }, { unit: 3, status: 'failed', reason: 'budget' },
  ] })
  expect(result.blocks.map(block => block.text)).toEqual(['12345'])
  expect((await extractPdf(pdf(['12345']), { maxTextChars: 5 })).status).toBe('ok')
})

test('Large PDF page text splits into bounded blocks without truncation', async () => {
  const text = 'A'.repeat(200001)
  const result = await extractPdf(pdf([text]))
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error('Expected long page PDF')
  expect(result.coverage.level).toBe('full')
  expect(result.blocks.length).toBe(2)
  expect(result.blocks.every(block => block.text.length <= 200000 && block.unit === 1)).toBe(true)
  expect(result.blocks.map(block => block.text).join('')).toBe(text)
  expect(ParsedDocumentResultSchema.safeParse(result).success).toBe(true)
}, 30000)

test('A damaged page retains successful pages and records a decode gap', async () => {
  const result = await extractPdf(pdf(['Before', 'Damaged', 'After'], { badPage: 2 }))
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error('Expected partial damaged-page PDF')
  expect(result.coverage).toEqual({ level: 'partial', totalUnits: 3, units: [
    { unit: 1, status: 'read' }, { unit: 2, status: 'failed', reason: 'decode-failed' }, { unit: 3, status: 'read' },
  ] })
  expect(result.blocks.map(block => block.text)).toEqual(['Before', 'After'])
})

test('Pre-cancelled PDF extraction stops before loading input', async () => {
  const controller = new AbortController()
  controller.abort()
  expect(await extractPdf(pdf(['Text']), undefined, controller.signal)).toEqual({ status: 'cancelled' })
})

test('Cancellation after invocation settles with no partial reading result', async () => {
  const controller = new AbortController()
  const input = pdf(['First', 'Second'])
  const original = input.slice()
  const result = extractPdf(input, undefined, controller.signal)
  queueMicrotask(() => controller.abort())
  expect(await result).toEqual({ status: 'cancelled' })
  expect(Buffer.from(input).equals(Buffer.from(original))).toBe(true)
})

test('PDF JavaScript and remote URI actions do not execute or fetch', async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  const taskGlobals = globalThis as typeof globalThis & { __bioPdfActionSentinel?: boolean }
  delete taskGlobals.__bioPdfActionSentinel
  const blockedFetch = (() => { requests++; throw new Error('No PDF network access') }) as unknown as typeof fetch
  globalThis.fetch = blockedFetch
  try {
    const result = await extractPdf(pdf(['Local text'], { activeContent: true }))
    expect(result.status).toBe('ok')
    expect(requests).toBe(0)
    expect(taskGlobals.__bioPdfActionSentinel).toBeUndefined()
  } finally {
    globalThis.fetch = originalFetch
    delete taskGlobals.__bioPdfActionSentinel
  }
})
