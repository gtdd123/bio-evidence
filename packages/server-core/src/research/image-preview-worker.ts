// Isolated Bun child: private input is binary stdin; no filenames, SDK, model,
// filesystem image reads, or diagnostic content leave this process.
import sharp from 'sharp'
import { z } from 'zod'
sharp.cache(false); sharp.concurrency(1)
const Command = z.strictObject({ kind: z.enum(['metadata', 'thumbnail', 'view']), frameIndex: z.number().int().min(0).max(1000000),
  maxPixels: z.number().int().min(1).max(50000000), length: z.number().int().min(0).max(268435456) })
const reply = (value: unknown, bytes?: Buffer) => { process.stdout.write(JSON.stringify(value) + '\n'); if (bytes) process.stdout.write(bytes) }
// TIFF descriptions can map IFDs to Z/C/T planes rather than an ordinary 2D
// sequence. Sharp's metadata omits this description, so reject that profile
// before decoding. Inspect bounded directory metadata only, never pixel strips.
function tiffProfile(input: Buffer): 'ok' | 'invalid' | 'unsupported' | 'budget' {
  if (input.length < 8) return 'invalid'
  const little = input[0] === 73
  const u16 = (at: number) => little ? input.readUInt16LE(at) : input.readUInt16BE(at)
  const u32 = (at: number) => little ? input.readUInt32LE(at) : input.readUInt32BE(at)
  const seen = new Set<number>()
  let ifd = u32(4), entries = 0
  if (!ifd) return 'invalid'
  while (ifd) {
    if (seen.has(ifd) || ifd < 8 || ifd + 2 > input.length) return 'invalid'
    if (seen.size >= 100000) return 'budget'
    seen.add(ifd)
    const count = u16(ifd), end = ifd + 2 + 12 * count
    entries += count
    if (entries > 1000000) return 'budget'
    if (!count || end + 4 > input.length) return 'invalid'
    let hasDescription = false
    for (let index = 0; index < count; index++) {
      const at = ifd + 2 + 12 * index, tag = u16(at)
      if (tag === 330) return 'unsupported'
      if (tag !== 270) continue
      if (hasDescription || u16(at + 2) !== 2) return 'invalid'
      hasDescription = true
      const length = u32(at + 4)
      if (length > 65536) return 'budget'
      if (!length) return 'invalid'
      const offset = length <= 4 ? at + 8 : u32(at + 8)
      if (offset + length > input.length || input[offset + length - 1] !== 0) return 'invalid'
      const description = input.subarray(offset, offset + length - 1).toString('utf8')
      if (/<(?:[A-Za-z_][\w.-]*:)?OME(?:\s|>|\/)/i.test(description) || /openmicroscopy\.org\/Schemas\/OME\//i.test(description)) return 'unsupported'
    }
    ifd = u32(end)
  }
  return 'ok'
}
async function run() {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 268435456 + 2048) { reply({ status: 'budget' }); return }
    chunks.push(Buffer.from(chunk))
  }
  const incoming = Buffer.concat(chunks), split = incoming.indexOf(10)
  if (split < 0 || split > 2048) { reply({ status: 'invalid' }); return }
  const command = Command.parse(JSON.parse(incoming.subarray(0, split).toString('utf8'))), input = incoming.subarray(split + 1)
  if (input.length !== command.length) { reply({ status: 'invalid' }); return }
  const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), jpeg = input[0] === 255 && input[1] === 216 && input[2] === 255
  const tiff = input.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || input.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))
  if (!png && !jpeg && !tiff) { reply({ status: input.length < 8 ? 'invalid' : 'unsupported' }); return }
  if (tiff) { const status = tiffProfile(input); if (status !== 'ok') { reply({ status }); return } }
  const metadata = await sharp(input, { page: command.frameIndex, pages: 1, limitInputPixels: false, failOn: 'warning' }).metadata()
  if (!['png', 'jpeg', 'tiff'].includes(metadata.format) || metadata.subifds) { reply({ status: 'unsupported' }); return }
  const height = metadata.pageHeight ?? metadata.height, width = metadata.width, pages = metadata.pages ?? 1
  if (command.frameIndex >= pages || !width || !height) { reply({ status: 'invalid' }); return }
  if (width * height > command.maxPixels) { reply({ status: 'budget' }); return }
  const info = { status: 'ok', width, height, pages, frameIndex: command.frameIndex, format: metadata.format }
  if (command.kind === 'metadata') { reply(info); return }
  const edge = command.kind === 'thumbnail' ? 256 : 2048
  const result = await sharp(input, { page: command.frameIndex, pages: 1, limitInputPixels: command.maxPixels, failOn: 'warning' })
    .rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
  if (result.data.length > 20 * 1024 * 1024) { reply({ status: 'budget' }); return }
  reply({ ...info, width: result.info.width, height: result.info.height }, result.data)
}
run().catch(() => reply({ status: 'invalid' }))
