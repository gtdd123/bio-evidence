import '../../../scripts/bio-runtime-guard.mjs'
import sharp from 'sharp'
import { DocumentParseService } from '../../server-core/src/research/document-parse'
import { ImageDecodeService } from '../../server-core/src/research/image-decode'
import { PublicModelWorkerService } from '../../server-core/src/research/public-model-worker'
import type { PreparedPublicInput } from '../../server-core/src/research/public-input'

function syntheticPdf() {
  const text = 'Synthetic delivery evidence', stream = `BT /F1 12 Tf 30 100 Td (${text}) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let file = '%PDF-1.7\n'; const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(file.length); file += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = file.length; file += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  return Buffer.from(file + `trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`)
}
function syntheticTiff() {
  const entryCount = 10, directorySize = 2 + entryCount * 12 + 4, pixels = 8 + directorySize * 2
  const file = Buffer.alloc(pixels + 6); file.write('II'); file.writeUInt16LE(42, 2); file.writeUInt32LE(8, 4)
  for (let page = 0; page < 2; page++) {
    const at = 8 + page * directorySize; file.writeUInt16LE(entryCount, at)
    const entries = [[256, 3, 1, 1], [257, 3, 1, 1], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, pixels + page * 3], [277, 3, 1, 1], [278, 4, 1, 1], [279, 4, 1, 1], [284, 3, 1, 1]]
    for (const [index, entry] of entries.entries()) { const offset = at + 2 + index * 12; file.writeUInt16LE(entry[0]!, offset); file.writeUInt16LE(entry[1]!, offset + 2); file.writeUInt32LE(entry[2]!, offset + 4); file.writeUInt32LE(entry[3]!, offset + 8) }
    file.writeUInt32LE(page === 0 ? 8 + directorySize : 0, at + 2 + entryCount * 12); file[pixels + page * 3] = page ? 220 : 20
  }
  return file
}
export async function verifyBioResources() {
  const parser = new DocumentParseService(), image = new ImageDecodeService(), model = new PublicModelWorkerService()
  try {
    const pdf = await parser.parse(syntheticPdf(), 'pdf')
    if (pdf.status !== 'ok' || !pdf.blocks.some(block => block.text.includes('Synthetic delivery evidence'))) throw Error('PDF worker/resources check failed')
    const jats = await parser.parse(Buffer.from('<article><front><article-meta><title-group><article-title>Synthetic delivery title</article-title></title-group></article-meta></front><body><sec><title>Results</title><p>Synthetic public evidence.</p></sec></body></article>'), 'jats')
    if (jats.status !== 'ok' || !jats.blocks.length) throw Error('JATS worker/resources check failed')
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#207c70' } }).png().toBuffer()
    const preview = await image.decode(png, 'view'), frame = await image.decode(syntheticTiff(), 'view', 1)
    if (preview.status !== 'ok' || frame.status !== 'ok' || frame.frameIndex !== 1 || frame.pages !== 2 || !frame.bytes) throw Error('Image worker/native resources check failed')
    const pixel = await sharp(frame.bytes).raw().toBuffer(); if (pixel[0] !== 220) throw Error('Selected TIFF frame differs')
    const prepared: PreparedPublicInput = { manifest: { id: 'synthetic', sessionId: 'synthetic', sessionRevision: 1, scope: { kind: 'personal', ownerId: 'synthetic' }, actorId: 'synthetic', declaredAt: 1, policyVersion: 1, contextHash: 'a'.repeat(64), connectionId: 'synthetic', model: 'synthetic-gpt' },
      modelInput: { question: 'Public delivery resource inspection', readingScope: 'selected-excerpts-only', blocks: [{ snapshotId: 'snapshot', sourceId: 'source', blockId: 'block', start: 0, end: 18, text: 'Synthetic evidence', locator: { kind: 'abstract' }, coverage: 'abstract', totalUnits: 1, selectedUnit: 1, identifiers: {}, metadataPending: false, contentHash: 'a'.repeat(64) }], evidence: [] },
      connection: { slug: 'synthetic', revision: 1, fingerprint: 'synthetic', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: { id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 } }, assertCurrent: () => {} }
    const inspected = JSON.parse(await model.run(prepared, 'evidence', 'synthetic-resource-inspection', undefined, 'inspect'))
    if (inspected.inheritedProviderKey || inspected.model !== 'synthetic-gpt' || inspected.tools.join(',') !== 'get_public_block,get_public_evidence') throw Error('SDK resource inspection failed')
    if (parser.activeProcessIds.length || image.activeProcessIds.length || model.activeProcessIds.length) throw Error('Resource child cleanup failed')
    return { pdf: 'passed', jats: 'passed', png: 'passed', tiffSelectedFrame: 'passed', sdkInspect: 'passed', liveModelRequests: 0 }
  } finally { await parser.close(); await image.close(); await model.close() }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await verifyBioResources())) }
  catch (error) { console.error(error instanceof Error ? error.message : 'Resource verification failed'); process.exitCode = 1 }
}
