import { expect, test } from 'bun:test'
import { RESEARCH_CHANNELS as R } from '@bio-evidence/research-core'
import { ResearchRunStateAdapter } from '../research-run-state'

const run = { id: 'run', sessionId: 'session', scope: { kind: 'personal', ownerId: 'alice' } as const, actorId: 'alice', connectionId: 'official', state: 'queued' as const, generation: 0, revision: 1, sourceIds: ['source'], artifactIds: [], createdAt: 1 }
const event = { version: 1, id: 'event', sequence: 1, scope: run.scope, sessionId: 'session', resourceId: 'run', revision: 2, kind: 'run-changed' }
function fixture() {
  let listener: (value: unknown) => void = () => {}, page = { items: [run] }, fail = false, release: (() => void) | undefined
  const calls: string[] = []
  const adapter = new ResearchRunStateAdapter({ invoke: async channel => { calls.push(channel); if (release) await new Promise<void>(resolve => { release = resolve }); if (fail) throw { code: 'BIO_ACCESS_DENIED', message: 'Synthetic private error body' }; return page }, on: (_channel, callback) => { listener = callback; return () => { listener = () => {} } } }, 'session')
  return { adapter, calls, emit: () => listener(event), setPage: (next: typeof page) => { page = next }, deny: () => { fail = true }, wait: () => { release = () => {} }, release: () => { const unblock = release; release = undefined; unblock?.() } }
}
test('metadata events trigger authoritative queries and cannot directly advance the visible run', async () => {
  const f = fixture()
  await f.adapter.refresh(); expect(f.adapter.state.page.items[0]?.state).toBe('queued')
  f.wait(); f.emit(); await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.adapter.state.page.items[0]?.state).toBe('queued')
  f.release(); await f.adapter.refresh()
  expect(f.calls.every(channel => channel === R.LIST_RUNS)).toBe(true)
  f.adapter.close()
})
test('current denial clears cached state and never exposes server error text', async () => {
  const f = fixture(); await f.adapter.refresh(); f.deny(); await f.adapter.refresh()
  expect(f.adapter.state).toMatchObject({ status: 'denied', page: { items: [] }, errorCode: 'BIO_ACCESS_DENIED' })
  expect(JSON.stringify(f.adapter.state)).not.toContain('private error body'); f.adapter.close()
})
test('disconnect and close invalidate late responses; reconnect only reads state and never resubmits a model run', async () => {
  const f = fixture(); f.wait(); const pending = f.adapter.refresh()
  await new Promise(resolve => setTimeout(resolve, 0)); f.adapter.connectionChanged(false); f.release(); await pending
  expect(f.adapter.state).toMatchObject({ status: 'disconnected', page: { items: [] } })
  await f.adapter.connectionChanged(true)
  expect(f.adapter.state.status).toBe('ready'); expect(f.calls.every(channel => channel === R.LIST_RUNS)).toBe(true)
  f.wait(); const last = f.adapter.refresh(); await new Promise(resolve => setTimeout(resolve, 0)); f.adapter.close(); f.release(); await last
  expect(f.adapter.state.page.items).toEqual([])
})
