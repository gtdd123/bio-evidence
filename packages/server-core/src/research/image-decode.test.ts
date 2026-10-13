import { test, expect } from 'bun:test'
import sharp from 'sharp'
import { ImageDecodeService } from './image-decode'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
test('real PNG and JPEG decode in bounded subprocesses, with thumbnail and view sizes', async () => {
  const decoder = new ImageDecodeService()
  for (const format of ['png', 'jpeg'] as const) {
    const input = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#57a2dc' } }).toFormat(format).toBuffer()
    const metadata = await decoder.decode(input, 'metadata')
    expect(metadata.status).toBe('ok')
    if (metadata.status !== 'ok') throw Error('Expected controlled image metadata')
    expect(metadata.width).toBe(2400); expect(metadata.height).toBe(1200); expect(metadata.pages).toBe(1)
    for (const [kind, edge] of [['thumbnail', 256], ['view', 2048]] as const) {
      const output = await decoder.decode(input, kind)
      expect(output.status).toBe('ok')
      if (output.status !== 'ok') throw Error('Expected controlled image preview')
      expect(Math.max(output.width, output.height)).toBe(edge)
      expect((await sharp(output.bytes!).metadata()).format).toBe('png')
    }
  }
  expect(decoder.activeProcessIds).toEqual([])
}, 15000)
test('bad inputs and configured byte/pixel budgets have explicit status', async () => {
  const input = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#57a2dc' } }).png().toBuffer()
  expect((await new ImageDecodeService({ maxInputBytes: 10 }).decode(input, 'view')).status).toBe('budget')
  expect((await new ImageDecodeService({ maxPixels: 100 }).decode(input, 'view')).status).toBe('budget')
  expect((await new ImageDecodeService().decode(Buffer.from('synthetic unknown format'), 'view')).status).toBe('unsupported')
  expect((await new ImageDecodeService().decode(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]), 'view')).status).toBe('invalid')
})
test('timeouts terminate real owned child processes and release concurrent slots', async () => {
  const workerPath = join(resolveConfigDir(), `t09-hang-${crypto.randomUUID()}.ts`)
  writeFileSync(workerPath, 'await Bun.stdin.arrayBuffer(); setInterval(() => {}, 1000)\n')
  const decoder = new ImageDecodeService({ workerPath, timeoutMs: 500, concurrency: 2 })
  const input = Buffer.from('Synthetic bounded fixture')
  const first = decoder.decode(input, 'metadata'), second = decoder.decode(input, 'metadata')
  const pids = decoder.activeProcessIds
  expect(pids).toHaveLength(2)
  expect((await decoder.decode(input, 'metadata')).status).toBe('busy')
  for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow()
  expect((await first).status).toBe('timeout'); expect((await second).status).toBe('timeout')
  expect(decoder.activeProcessIds).toEqual([])
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
  expect((await decoder.decode(input, 'metadata')).status).toBe('timeout')
})
test('client cancellation terminates the owned decoder process before returning', async () => {
  const workerPath = join(resolveConfigDir(), `t09-abort-${crypto.randomUUID()}.ts`)
  writeFileSync(workerPath, 'await Bun.stdin.arrayBuffer(); setInterval(() => {}, 1000)\n')
  const decoder = new ImageDecodeService({ workerPath }), controller = new AbortController()
  const task = decoder.decode(Buffer.from('synthetic input'), 'metadata', 0, controller.signal), pid = decoder.activeProcessIds[0]!
  expect(pid).toBeGreaterThan(0); controller.abort()
  expect((await task).status).toBe('unavailable'); expect(decoder.activeProcessIds).toEqual([])
  expect(() => process.kill(pid, 0)).toThrow()
})
test('closing the decoder terminates active child processes and prevents new work', async () => {
  const workerPath = join(resolveConfigDir(), `t09-close-${crypto.randomUUID()}.ts`)
  writeFileSync(workerPath, 'await Bun.stdin.arrayBuffer(); setInterval(() => {}, 1000)\n')
  const decoder = new ImageDecodeService({ workerPath }), input = Buffer.from('synthetic input')
  const controller = new AbortController(), task = decoder.decode(input, 'metadata', 0, controller.signal), pid = decoder.activeProcessIds[0]!
  try {
    await decoder.close()
    expect((await task).status).toBe('unavailable'); expect(decoder.activeProcessIds).toEqual([])
    expect(() => process.kill(pid, 0)).toThrow()
    expect((await decoder.decode(input, 'metadata')).status).toBe('unavailable')
  } finally { controller.abort(); await task }
})
