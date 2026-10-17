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

function detail(id: string) {
  return { run: { ...run, id }, operationId: `operation-${id}`, purpose: 'evidence', manifest: { id: `manifest-${id}`, sessionId: 'session', sessionRevision: 1, scope: run.scope,
    actorId: 'alice', declaredAt: 1, policyVersion: 1, contextHash: 'a'.repeat(64), connectionId: 'official', model: 'synthetic-gpt' },
    input: { question: 'Public fixture', readingScope: 'selected-excerpts-only', blocks: [{ snapshotId: 'snapshot', sourceId: 'source', blockId: 'block', start: 0, end: 6,
      text: 'public', locator: { kind: 'pdf-page', page: 1 }, coverage: 'full', totalUnits: 1, selectedUnit: 1, identifiers: {}, metadataPending: false, contentHash: 'b'.repeat(64) }], evidence: [] },
    modelRequests: [], projectionPending: false, projectionStatus: 'none', steps: [] }
}
test('switching selected GET and paging drops the old detail while preserving explicit read-only recovery', async () => {
  let release!: (value: unknown) => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), calls: Array<{ channel: string; input: any }> = [], selected: string[] = []
  const adapter = new ResearchRunStateAdapter({ invoke: async (channel, input) => {
    calls.push({ channel, input })
    if (channel === R.LIST_RUNS) return { items: [{ ...run, id: 'run-a' }, { ...run, id: 'run-b' }], nextCursor: 'run-b' }
    if (input.runId === 'run-a') { entered(); return new Promise(resolve => { release = resolve }) }
    return detail('run-b')
  }, on: () => () => {} }, 'session', state => { if (state.selected) selected.push(state.selected.run.id) })
  const old = adapter.selectRun('run-a'); await started
  const next = adapter.selectRun('run-b'); release(detail('run-a')); await Promise.all([old, next])
  expect(adapter.state.selected?.run.id).toBe('run-b'); expect(selected).not.toContain('run-a')
  await adapter.pageAfter('run-b')
  expect(calls).toContainEqual({ channel: R.LIST_RUNS, input: { sessionId: 'session', pageSize: 20, cursor: 'run-b' } })
  expect(calls.every(call => call.channel === R.GET_RUN || call.channel === R.LIST_RUNS)).toBe(true)
  adapter.close()
})
test('response budget counts UTF-8 bytes and rejects above 2 MiB before rendering or schema decoding', async () => {
  let response: unknown = { items: [], padding: '界'.repeat(700000) }
  const adapter = new ResearchRunStateAdapter({ invoke: async () => response, on: () => () => {} }, 'session')
  await adapter.refresh(); expect(adapter.state).toMatchObject({ status: 'error', page: { items: [] }, errorCode: 'BIO_MODEL_BUDGET' })
  const empty = { items: [], padding: '' }
  response = { ...empty, padding: 'x'.repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty))) }
  expect(Buffer.byteLength(JSON.stringify(response))).toBe(2 * 1024 * 1024)
  await adapter.refresh(); expect(adapter.state.errorCode).toBe('BIO_INPUT_INVALID')
  adapter.close()
})
