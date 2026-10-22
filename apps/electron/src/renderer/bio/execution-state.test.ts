import { expect, test } from 'bun:test'
import type { ResearchRunView, ResearchConnectionView } from '@bio-evidence/research-core'
import { recentModelSuccess, traceDuration } from './execution-state'
test('green model status needs an actual recent receipt for this exact route revision', () => {
  const connection = { slug: 'route', revision: 2, enabled: true } as ResearchConnectionView
  const view = { manifest: { connectionId: 'route', model: 'gpt' }, connectionRevision: 2, trace: [{ kind: 'model', state: 'completed', finishedAt: 1000 }], modelRequests: [{ state: 'completed' }] } as ResearchRunView
  expect(recentModelSuccess(undefined, connection, 'gpt', 1001)).toBeUndefined()
  expect(recentModelSuccess(view, connection, 'gpt', 1001)).toBe(1000)
  expect(recentModelSuccess(view, { ...connection, revision: 3 }, 'gpt', 1001)).toBeUndefined()
  expect(recentModelSuccess(view, connection, 'another-model', 1001)).toBeUndefined()
  expect(recentModelSuccess(view, connection, 'gpt', 301001)).toBeUndefined()
  expect(recentModelSuccess({ ...view, modelRequests: [] }, connection, 'gpt', 1001)).toBeUndefined()
})
test('durations use real endpoints; pending events do not invent elapsed values', () => {
  expect(traceDuration({ id: 'one', sequence: 1, kind: 'tool', state: 'pending', startedAt: 20 })).toBeUndefined()
  expect(traceDuration({ id: 'two', sequence: 2, kind: 'model', state: 'completed', startedAt: 20, finishedAt: 31 })).toBe(11)
})
