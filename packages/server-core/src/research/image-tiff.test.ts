import { test, expect } from 'bun:test'
import sharp from 'sharp'
import { ImageDecodeService } from './image-decode'

type Page = { width: number, height: number, colour: readonly [number, number, number], description?: string }

// Owned in-memory TIFF 6.0 fixture: RGB, uncompressed, one strip per page.
// IFDs and pixel buffers are synthetic; no original material is read or written.
function classicTiff(pages: Page[], options: { endian?: 'II' | 'MM', subifd?: boolean } = {}): Buffer {
  const little = options.endian !== 'MM'
  const layouts: { ifd: number, tags: number, bits: number, description: number, pixels: number, end: number }[] = []
  let next = 8
  for (const page of pages) {
    const tags = 10 + (page.description ? 1 : 0) + (options.subifd && layouts.length === 0 ? 1 : 0)
    const ifd = next, bits = ifd + 2 + 12 * tags + 4
    const description = bits + 6
    const pixels = description + (page.description ? Buffer.byteLength(page.description, 'utf8') + 1 : 0)
    next = pixels + page.width * page.height * 3
    if (next % 2) next++
    layouts.push({ ifd, tags, bits, description, pixels, end: next })
  }
  const bytes = Buffer.alloc(next)
  const u16 = (value: number, at: number) => little ? bytes.writeUInt16LE(value, at) : bytes.writeUInt16BE(value, at)
  const u32 = (value: number, at: number) => little ? bytes.writeUInt32LE(value, at) : bytes.writeUInt32BE(value, at)
  bytes.write(little ? 'II' : 'MM', 0, 'ascii'); u16(42, 2); u32(layouts[0]!.ifd, 4)
  pages.forEach((page, index) => {
    const layout = layouts[index]!
    const tags: [number, number, number, number][] = [
      [256, 4, 1, page.width], [257, 4, 1, page.height], [258, 3, 3, layout.bits],
      [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, layout.pixels], [277, 3, 1, 3],
      [278, 4, 1, page.height], [279, 4, 1, page.width * page.height * 3], [284, 3, 1, 1],
    ]
    if (page.description) tags.push([270, 2, Buffer.byteLength(page.description, 'utf8') + 1, layout.description])
    if (options.subifd && index === 0) tags.push([330, 4, 1, layouts[1]!.ifd])
    tags.sort((a, b) => a[0] - b[0]); u16(tags.length, layout.ifd)
    tags.forEach(([tag, type, count, value], tagIndex) => {
      const at = layout.ifd + 2 + 12 * tagIndex
      u16(tag, at); u16(type, at + 2); u32(count, at + 4)
      if (type === 3 && count === 1) u16(value, at + 8)
      else u32(value, at + 8)
    })
    u32(options.subifd ? 0 : layouts[index + 1]?.ifd ?? 0, layout.ifd + 2 + 12 * tags.length)
    for (let sample = 0; sample < 3; sample++) u16(8, layout.bits + sample * 2)
    if (page.description) bytes.write(page.description, layout.description, 'utf8')
    for (let at = layout.pixels; at < layout.pixels + page.width * page.height * 3; at += 3) {
      bytes[at] = page.colour[0]; bytes[at + 1] = page.colour[1]; bytes[at + 2] = page.colour[2]
    }
  })
  return bytes
}

function grayscale16Tiff(width: number, height: number): Buffer {
  const tags: [number, number, number][] = [
    [256, 4, width], [257, 4, height], [258, 3, 16], [259, 3, 1], [262, 3, 1],
    [273, 4, 8 + 2 + 12 * 12 + 4], [274, 3, 1], [277, 3, 1], [278, 4, height],
    [279, 4, width * height * 2], [284, 3, 1], [339, 3, 1],
  ]
  const pixels = tags.find(([tag]) => tag === 273)![2]
  const bytes = Buffer.alloc(pixels + width * height * 2)
  bytes.write('II', 0, 'ascii'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4)
  bytes.writeUInt16LE(tags.length, 8)
  tags.forEach(([tag, type, value], index) => {
    const at = 10 + index * 12
    bytes.writeUInt16LE(tag, at); bytes.writeUInt16LE(type, at + 2); bytes.writeUInt32LE(1, at + 4)
    if (type === 3) bytes.writeUInt16LE(value, at + 8)
    else bytes.writeUInt32LE(value, at + 8)
  })
  // Unsigned 16-bit intensity ramp spans the full representable range.
  for (let pixel = 0; pixel < width * height; pixel++) bytes.writeUInt16LE(pixel % 65536, pixels + pixel * 2)
  return bytes
}

async function expectPngColour(bytes: Uint8Array, width: number, height: number, colour: readonly [number, number, number]) {
  const metadata = await sharp(bytes).metadata()
  expect(metadata.format).toBe('png'); expect(metadata.width).toBe(width); expect(metadata.height).toBe(height)
  const output = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  expect(output.info.channels).toBe(3)
  // Check the entire image: a stacked second page or wrong selected page cannot pass.
  expect(output.data.every((sample, index) => sample === colour[index % 3])).toBe(true)
}

test('ordinary little- and big-endian single-page 2D TIFF produce exact PNG colour and dimensions', async () => {
  const decoder = new ImageDecodeService()
  for (const endian of ['II', 'MM'] as const) {
    const colour = [27, 145, 211] as const, input = classicTiff([{ width: 60, height: 40, colour }], { endian })
    const check = await sharp(input).metadata()
    expect(check.format).toBe('tiff'); expect(check.width).toBe(60); expect(check.height).toBe(40)
    const metadata = await decoder.decode(input, 'metadata')
    expect(metadata).toEqual({ status: 'ok', width: 60, height: 40, pages: 1, frameIndex: 0, format: 'tiff' })
    const view = await decoder.decode(input, 'view')
    expect(view.status).toBe('ok')
    if (view.status !== 'ok' || !view.bytes) throw Error('Expected controlled TIFF preview')
    await expectPngColour(view.bytes, 60, 40, colour)
  }
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)

test('ordinary 16-bit grayscale 2D TIFF retains input dimensions and produces readable bounded PNG previews', async () => {
  const input = grayscale16Tiff(2304, 1152), saved = Buffer.from(input)
  const fixture = await sharp(input).metadata()
  expect(fixture.format).toBe('tiff'); expect(fixture.depth).toBe('ushort'); expect(fixture.channels).toBe(1)
  expect(fixture.width).toBe(2304); expect(fixture.height).toBe(1152)
  const decoder = new ImageDecodeService()
  expect(await decoder.decode(input, 'metadata')).toEqual({ status: 'ok', width: 2304, height: 1152, pages: 1, frameIndex: 0, format: 'tiff' })
  for (const [kind, width, height, edge] of [['thumbnail', 256, 128, 256], ['view', 2048, 1024, 2048]] as const) {
    const preview = await decoder.decode(input, kind)
    expect(preview.status).toBe('ok')
    if (preview.status !== 'ok' || !preview.bytes) throw Error('Expected controlled grayscale TIFF preview')
    expect(preview.width).toBe(width); expect(preview.height).toBe(height)
    expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(edge)
    const png = await sharp(preview.bytes).metadata()
    expect(png.format).toBe('png'); expect(png.width).toBe(width); expect(png.height).toBe(height)
    const readable = await sharp(preview.bytes).raw().toBuffer({ resolveWithObject: true })
    expect(readable.data.length).toBe(width * height * readable.info.channels)
  }
  expect(input.equals(saved)).toBe(true)
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)

test('two-page TIFF reports the actual count and renders only selected page 0 or 1', async () => {
  const colours = [[212, 35, 71], [16, 173, 85]] as const
  const input = classicTiff(colours.map(colour => ({ width: 512, height: 320, colour })))
  const check = await sharp(input).metadata()
  expect(check.pages).toBe(2)
  const decoder = new ImageDecodeService({ maxPixels: 512 * 320 })
  // The combined stack exceeds maxPixels; each requested 2D page stays within it.
  for (const frameIndex of [0, 1]) {
    expect(await decoder.decode(input, 'metadata', frameIndex)).toEqual({ status: 'ok', width: 512, height: 320, pages: 2, frameIndex, format: 'tiff' })
    for (const [kind, width, height] of [['thumbnail', 256, 160], ['view', 512, 320]] as const) {
      const preview = await decoder.decode(input, kind, frameIndex)
      expect(preview.status).toBe('ok')
      if (preview.status !== 'ok' || !preview.bytes) throw Error('Expected controlled selected page')
      expect(preview.pages).toBe(2); expect(preview.frameIndex).toBe(frameIndex)
      await expectPngColour(preview.bytes, width, height, colours[frameIndex]!)
    }
  }
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)

test('rendering page zero does not decode a damaged pixel strip on page one', async () => {
  const input = classicTiff([{ width: 16, height: 12, colour: [21, 43, 65] }, { width: 16, height: 12, colour: [87, 109, 131] }])
  const first = input.readUInt32LE(4), second = input.readUInt32LE(first + 2 + input.readUInt16LE(first) * 12)
  for (let index = 0; index < input.readUInt16LE(second); index++) {
    const entry = second + 2 + index * 12
    if (input.readUInt16LE(entry) === 273) input.writeUInt32LE(input.length + 1000, entry + 8)
  }
  const decoder = new ImageDecodeService()
  const selected = await decoder.decode(input, 'view', 0)
  expect(selected.status).toBe('ok')
  if (selected.status !== 'ok' || !selected.bytes) throw Error('Expected undamaged selected page')
  expect(selected.pages).toBe(2)
  await expectPngColour(selected.bytes, 16, 12, [21, 43, 65])
  expect((await decoder.decode(input, 'view', 1)).status).toBe('invalid')
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)

test('out-of-range TIFF pages and damaged directories return invalid without residual children', async () => {
  const input = classicTiff([{ width: 16, height: 16, colour: [31, 47, 63] }, { width: 16, height: 16, colour: [95, 111, 127] }])
  const decoder = new ImageDecodeService()
  expect((await decoder.decode(input, 'metadata', 2)).status).toBe('invalid')
  expect((await decoder.decode(input, 'view', 2)).status).toBe('invalid')
  const damaged = Buffer.from(input); damaged.writeUInt32LE(input.length + 500, 4)
  expect((await decoder.decode(damaged, 'metadata')).status).toBe('invalid')
  expect((await decoder.decode(input.subarray(0, 50), 'view')).status).toBe('invalid')
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)

test('valid synthetic BigTIFF is explicitly unsupported by the 2D preview profile', async () => {
  const input = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#296cad' } })
    .tiff({ bigtiff: true, compression: 'lzw' }).toBuffer()
  expect(input.subarray(0, 4)).toEqual(Buffer.from([73, 73, 43, 0]))
  expect((await sharp(input).metadata()).format).toBe('tiff')
  const decoder = new ImageDecodeService()
  expect((await decoder.decode(input, 'metadata')).status).toBe('unsupported')
  expect((await decoder.decode(input, 'view')).status).toBe('unsupported')
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)

test('real sub-IFD TIFF pyramid is explicitly unsupported', async () => {
  const input = classicTiff([{ width: 64, height: 48, colour: [201, 71, 51] }, { width: 32, height: 24, colour: [83, 121, 219] }], { subifd: true })
  const check = await sharp(input).metadata()
  expect(check.format).toBe('tiff'); expect(check.subifds).toBe(1)
  const decoder = new ImageDecodeService()
  expect((await decoder.decode(input, 'metadata')).status).toBe('unsupported')
  expect((await decoder.decode(input, 'view')).status).toBe('unsupported')
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)

test('multi-dimensional OME description cannot silently become a plain sequence of 2D frames', async () => {
  const description = '<?xml version="1.0" encoding="UTF-8"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint8" SizeX="32" SizeY="24" SizeZ="2" SizeC="3" SizeT="1" Interleaved="true"><Channel ID="Channel:0:0" SamplesPerPixel="3"/><TiffData/></Pixels></Image></OME>'
  const input = classicTiff([{ width: 32, height: 24, colour: [27, 39, 51], description }, { width: 32, height: 24, colour: [121, 133, 145] }])
  const check = await sharp(input).metadata()
  expect(check.format).toBe('tiff'); expect(check.pages).toBe(2)
  const decoder = new ImageDecodeService()
  expect((await decoder.decode(input, 'metadata')).status).toBe('unsupported')
  expect((await decoder.decode(input, 'view', 1)).status).toBe('unsupported')
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)

test('ordinary TIFF descriptions stay supported while namespaced OME in later pages is rejected', async () => {
  const decoder = new ImageDecodeService()
  for (const endian of ['II', 'MM'] as const) {
    const ordinary = classicTiff([{ width: 16, height: 12, colour: [41, 63, 85], description: 'Synthetic ordinary 2D image' }], { endian })
    const saved = Buffer.from(ordinary)
    expect((await decoder.decode(ordinary, 'view')).status).toBe('ok')
    expect(ordinary.equals(saved)).toBe(true)
    const special = classicTiff([{ width: 16, height: 12, colour: [41, 63, 85] },
      { width: 16, height: 12, colour: [107, 129, 151], description: '<mic:OME xmlns:mic="urn:synthetic-ome-fixture"/>' }], { endian })
    expect((await decoder.decode(special, 'metadata')).status).toBe('unsupported')
    expect((await decoder.decode(special, 'view', 1)).status).toBe('unsupported')
  }
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)

test('cyclic TIFF directories and oversized or unterminated descriptions fail explicitly', async () => {
  const decoder = new ImageDecodeService()
  const cycle = classicTiff([{ width: 16, height: 12, colour: [11, 33, 55] }])
  const first = cycle.readUInt32LE(4)
  cycle.writeUInt32LE(first, first + 2 + cycle.readUInt16LE(first) * 12)
  expect((await decoder.decode(cycle, 'metadata')).status).toBe('invalid')
  const oversized = classicTiff([{ width: 16, height: 12, colour: [11, 33, 55], description: 's'.repeat(65536) }])
  expect((await decoder.decode(oversized, 'metadata')).status).toBe('budget')
  const unterminated = classicTiff([{ width: 16, height: 12, colour: [11, 33, 55], description: 'Synthetic comment' }])
  for (let index = 0; index < unterminated.readUInt16LE(first); index++) {
    const entry = first + 2 + index * 12
    if (unterminated.readUInt16LE(entry) === 270) {
      const length = unterminated.readUInt32LE(entry + 4), offset = unterminated.readUInt32LE(entry + 8)
      unterminated[offset + length - 1] = 65
    }
  }
  expect((await decoder.decode(unterminated, 'metadata')).status).toBe('invalid')
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)
