import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { createOwnedShutdown } from './owned-shutdown'

test('duplicate stop waits for flush and reports success exactly once', async () => {
  let release!: () => void, stops = 0
  const flushed = new Promise<void>(resolve => { release = resolve }), codes: number[] = [], input = new PassThrough()
  const control = createOwnedShutdown(async () => { stops++; await flushed }, code => { codes.push(code) }, input)
  input.write('{"type":"shutdown"}\n'); const pending = control.request(0); input.end()
  await Promise.resolve(); expect(stops).toBe(1); expect(codes).toEqual([])
  release(); await pending; await control.request(1)
  expect(codes).toEqual([0]); expect(stops).toBe(1)
})
test('malformed control and cleanup failure fail closed without exposing stream contents', async () => {
  const codes: number[] = [], input = new PassThrough()
  const control = createOwnedShutdown(async () => {}, code => { codes.push(code) }, input)
  input.write('{"type":"execute","body":"synthetic private text"}\n'); await control.request(0)
  expect(codes).toEqual([1])
  const failed: number[] = [], failure = createOwnedShutdown(async () => { throw Error('Synthetic cleanup failure') }, code => { failed.push(code) })
  await failure.request(0); expect(failed).toEqual([1])
})
