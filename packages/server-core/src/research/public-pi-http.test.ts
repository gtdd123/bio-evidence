import { expect, test } from 'bun:test'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace.mjs'
import { runPublicPi } from './public-pi-runtime'
const input = { question: 'Public question', readingScope: 'selected-excerpts-only' as const, blocks: [{ snapshotId: 'snapshot', sourceId: 'source', blockId: 'block', start: 0, end: 18, text: 'Synthetic evidence', locator: { kind: 'abstract' as const }, coverage: 'abstract' as const, totalUnits: 1, selectedUnit: 1, identifiers: {}, metadataPending: false, contentHash: 'a'.repeat(64) }], evidence: [] }
function responses(text: string) {
  const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  const response = { id: 'resp_synthetic', object: 'response', status: 'completed', model: 'synthetic-gpt', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
for (const api of ['openai-responses', 'openai-completions'] as const) test(`actual ${api} SDK adapter sends exactly selected endpoint, key, public context and store:false`, async () => {
  const original = globalThis.fetch, requests: { url: string; body: any; authorization: string | null }[] = [], text = '{"candidate":"synthetic"}'
  const baseUrl = api === 'openai-responses' ? 'https://api.openai.com/v1' : 'https://compat.invalid/v1'
  try {
    const fake = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('Authorization') })
      const data = api === 'openai-responses' ? responses(text) : [
        { id: 'chat_synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic-gpt', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
        { id: 'chat_synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic-gpt', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
      return new Response(data, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    globalThis.fetch = Object.assign(fake, { preconnect: original.preconnect }) as typeof fetch
    const result = await runPublicPi({ purpose: 'evidence', input, apiKey: 'synthetic-selected-key', connection: { api, baseUrl, model: { id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 } } }, { cwd: resolveConfigDir(), authorize: async () => {} })
    expect(result).toBe(text); expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(baseUrl + (api === 'openai-responses' ? '/responses' : '/chat/completions'))
    expect(requests[0]!.authorization).toBe('Bearer synthetic-selected-key'); expect(requests[0]!.body.model).toBe('synthetic-gpt'); expect(requests[0]!.body.store).toBe(false)
    expect(JSON.stringify(requests[0]!.body)).toContain('Synthetic evidence'); expect(JSON.stringify(requests[0]!.body)).not.toContain(resolveConfigDir())
  } finally { globalThis.fetch = original }
})

for (const api of ['openai-responses', 'openai-completions'] as const) {
  for (const [status, code] of [[401, 'BIO_MODEL_AUTH_FAILED'], [403, 'BIO_MODEL_AUTH_FAILED'], [429, 'BIO_MODEL_RATE_LIMITED'], [408, 'BIO_MODEL_TIMEOUT'], [504, 'BIO_MODEL_TIMEOUT'], [400, 'BIO_MODEL_UNSUPPORTED'], [404, 'BIO_MODEL_UNSUPPORTED'], [503, 'BIO_MODEL_UNAVAILABLE']] as const) {
    test(`${api} maps HTTP ${status} to a safe ${code} without retries or fallback`, async () => {
      const original = globalThis.fetch
      let requests = 0, failure: unknown
      try {
        const fake = async () => {
          requests++
          return new Response(JSON.stringify({ error: { message: 'synthetic-selected-key PRIVATE-PROVIDER-BODY', type: 'synthetic_error' } }), { status, headers: { 'Content-Type': 'application/json' } })
        }
        globalThis.fetch = Object.assign(fake, { preconnect: original.preconnect }) as typeof fetch
        try {
          await runPublicPi({ purpose: 'evidence', input, apiKey: 'synthetic-selected-key', connection: { api, baseUrl: api === 'openai-responses' ? 'https://api.openai.com/v1' : 'https://compat.invalid/v1', model: { id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 } } }, { cwd: resolveConfigDir(), authorize: async () => {} })
        } catch (error) { failure = error }
        expect(failure).toMatchObject({ code })
        expect(String(failure)).not.toContain('synthetic-selected-key')
        expect(String(failure)).not.toContain('PRIVATE-PROVIDER-BODY')
        expect(requests).toBe(1)
      } finally { globalThis.fetch = original }
    })
  }
}
