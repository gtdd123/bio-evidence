import { expect, test } from 'bun:test'
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai/compat'
import { runPublicPi } from './public-pi-runtime'
const job = { purpose: 'evidence', input: { question: 'Public question', readingScope: 'selected-excerpts-only', blocks: [{ snapshotId: 'snapshot', sourceId: 'source', blockId: 'block', start: 0, end: 8, text: 'Evidence', locator: { kind: 'abstract' }, coverage: 'abstract', totalUnits: 1, selectedUnit: 1, identifiers: {}, metadataPending: false, contentHash: 'a'.repeat(64) }], evidence: [] }, apiKey: 'synthetic-key', connection: { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: { id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 } } }
function reply(tool: boolean): AssistantMessage { return { role: 'assistant', content: tool ? [{ type: 'toolCall', id: 'call-1', name: 'get_public_block', arguments: { snapshotId: 'snapshot', blockId: 'block' } }] : [{ type: 'text', text: '{"candidate":"synthetic"}' }], api: 'openai-responses', provider: 'bio-public', model: 'synthetic-gpt', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: tool ? 'toolUse' : 'stop', timestamp: 1 } }
test('Safe exposes zero tools to the actual SDK session', async () => {
  const result = await runPublicPi({ ...job, executionMode: 'safe' }, { authorize: async () => {}, inspect: true })
  expect(JSON.parse(result).tools).toEqual([])
})
test('Ask waits for each concrete public tool approval before reading and continuing the model', async () => {
  let calls = 0, release!: () => void, requested!: () => void
  const ready = new Promise<void>(resolve => { requested = resolve }), gate = new Promise<void>(resolve => { release = resolve }), events: string[] = []
  const result = runPublicPi({ ...job, executionMode: 'ask' }, { authorize: async () => {}, toolEvent: async event => { events.push(event.phase); if (event.phase === 'request') { requested(); await gate } }, stream: () => {
    const stream = createAssistantMessageEventStream(), message = reply(++calls === 1); stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message }); return stream
  } })
  await ready; expect(calls).toBe(1); expect(events).toEqual(['request'])
  release(); expect(await result).toBe('{"candidate":"synthetic"}'); expect(events).toEqual(['request', 'completed']); expect(calls).toBe(2)
})
test('Ask denial stops before another model call', async () => {
  let calls = 0
  const result = runPublicPi({ ...job, executionMode: 'ask' }, { authorize: async () => {}, toolEvent: async () => { throw Error('operator denied') }, stream: () => {
    const stream = createAssistantMessageEventStream(), message = reply(++calls === 1); stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'toolUse', message }); return stream
  } })
  await expect(result).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' }); expect(calls).toBe(1)
})
