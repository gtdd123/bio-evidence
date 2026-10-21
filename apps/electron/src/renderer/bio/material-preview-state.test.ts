import { expect, test } from 'bun:test'
import type { MaterialImageResult } from '@bio-evidence/research-core'
import { MaterialPreviewController, type MaterialPreviewState } from './material-preview-state'

const image = (index: number): MaterialImageResult => ({ rootId: 'root', fileId: 'file', generation: 1, kind: 'view', frameIndex: index,
  policy: 'restricted', status: 'ok', format: 'tiff', width: 512, height: 512, pages: 12, bytes: Uint8Array.of(index) })
function deferred() {
  let resolve!: (value: MaterialImageResult) => void
  let reject!: (error: unknown) => void
  return { promise: new Promise<MaterialImageResult>((yes, no) => { resolve = yes; reject = no }), resolve, reject }
}
function setup() {
  const frames = new Map<number, ReturnType<typeof deferred>>(), states: MaterialPreviewState[] = [], created: string[] = [], revoked: string[] = []
  const controller = new MaterialPreviewController({ pages: 12, file: { rootId: 'root', fileId: 'file', generation: 1 }, loadFrame(index) { const frame = deferred(); frames.set(index, frame); return frame.promise },
    createUrl(bytes) { const url = `blob:frame-${bytes[0]}`; created.push(url); return url }, revokeUrl(url) { revoked.push(url) }, changed(state) { states.push(state) } })
  return { controller, frames, states, created, revoked }
}

test('new frame selection clears the previous preview immediately and ignores a late older response', async () => {
  const { controller, frames, states, created } = setup()
  const first = controller.load(0), third = controller.load(2)
  expect(states.at(-1)).toEqual({ frameIndex: 2, status: 'loading', url: '' })
  frames.get(2)!.resolve(image(2)); await third
  frames.get(0)!.resolve(image(0)); await first
  expect(created).toEqual(['blob:frame-2'])
  expect(states.at(-1)).toMatchObject({ frameIndex: 2, status: 'ready', url: 'blob:frame-2' })
})

test('loading another frame and leaving the file revoke owned URLs exactly once', async () => {
  const { controller, frames, states, revoked } = setup()
  const first = controller.load(0); frames.get(0)!.resolve(image(0)); await first
  const next = controller.load(1)
  expect(revoked).toEqual(['blob:frame-0'])
  expect(states.at(-1)?.url).toBe('')
  frames.get(1)!.resolve(image(1)); await next
  controller.close(); controller.close()
  expect(revoked).toEqual(['blob:frame-0', 'blob:frame-1'])
})

test('a response after file teardown cannot allocate a URL or update the removed view', async () => {
  const { controller, frames, states, created } = setup()
  const first = controller.load(0), beforeClose = states.length
  controller.close(); frames.get(0)!.resolve(image(0)); await first
  expect(created).toEqual([])
  expect(states).toHaveLength(beforeClose)
  await controller.load(1)
  expect(frames.has(1)).toBe(false)
})

test('unavailable responses and denied reads leave no previous image visible', async () => {
  const { controller, frames, states, revoked } = setup()
  const first = controller.load(0); frames.get(0)!.resolve(image(0)); await first
  const unavailable = controller.load(1)
  frames.get(1)!.resolve({ rootId: 'root', fileId: 'file', generation: 1, kind: 'view', frameIndex: 1, policy: 'restricted', status: 'unavailable' }); await unavailable
  expect(states.at(-1)).toMatchObject({ status: 'unavailable', url: '' })
  expect(revoked).toEqual(['blob:frame-0'])
  const denied = controller.load(2); frames.get(2)!.reject({ code: 'BIO_ACCESS_DENIED' }); await denied
  expect(states.at(-1)).toMatchObject({ frameIndex: 2, status: 'error', url: '', error: { code: 'BIO_ACCESS_DENIED' } })
})

test('frame numbers outside the metadata range never issue a read', async () => {
  const { controller, frames } = setup()
  for (const index of [-1, 12, Number.NaN, 1.5]) await expect(controller.load(index)).rejects.toBeInstanceOf(RangeError)
  expect(frames.size).toBe(0)
})

test('a mismatched file revision or frame cannot become an authorized preview', async () => {
  for (const patch of [{ fileId: 'other-file' }, { generation: 2 }, { frameIndex: 5 }]) {
    const { controller, frames, states, created } = setup()
    const pending = controller.load(0); frames.get(0)!.resolve({ ...image(0), ...patch }); await pending
    expect(created).toEqual([])
    expect(states.at(-1)).toMatchObject({ status: 'error', url: '', error: { code: 'BIO_INPUT_INVALID' } })
  }
})
