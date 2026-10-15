import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai/compat'
import { runPublicPi } from './public-pi-runtime'
const input = { question: 'Public question', readingScope: 'selected-excerpts-only' as const, blocks: [{ snapshotId: 'snapshot', sourceId: 'source', blockId: 'block', start: 0, end: 18, text: 'Synthetic evidence', locator: { kind: 'abstract' as const }, coverage: 'abstract' as const, totalUnits: 1, selectedUnit: 1, identifiers: {}, metadataPending: false, contentHash: 'a'.repeat(64) }], evidence: [] }
function message(content: AssistantMessage['content'], tool = false): AssistantMessage { return { role: 'assistant', content, api: 'openai-responses', provider: 'bio-public', model: 'synthetic-gpt', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: tool ? 'toolUse' : 'stop', timestamp: 1 } }
test('actual Pi session ignores existing AGENTS MEMORY extensions and SDK history; only approved tools reach final model context', async () => {
  mkdirSync(resolve('.fixtures'), { recursive: true }); const root = mkdtempSync(resolve('.fixtures/public-pi-')), cwd = join(root, 'project'), agentDir = join(root, '.pi')
  mkdirSync(cwd); mkdirSync(join(agentDir, 'extensions'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), 'PRIVATE-ANCESTOR'); writeFileSync(join(cwd, 'AGENTS.md'), 'PRIVATE-PROJECT'); writeFileSync(join(cwd, 'MEMORY.md'), 'PRIVATE-MEMORY')
  const marker = join(root, 'extension-loaded')
  writeFileSync(join(agentDir, 'extensions', 'secret.ts'), `import {writeFileSync} from 'node:fs'; export default () => { writeFileSync(${JSON.stringify(marker)}, 'PRIVATE-EXTENSION') }`)
  const oldSession = SessionManager.create(cwd, join(agentDir, 'sessions')); oldSession.appendMessage({ role: 'user', content: 'PRIVATE-SDK-HISTORY', timestamp: 1 })
  oldSession.appendMessage(message([{ type: 'text', text: 'PRIVATE-SDK-HISTORY-ASSISTANT' }]))
  const observed: Context[] = [], approvals: string[] = [], payloads: any[] = []
  try {
    expect(existsSync(oldSession.getSessionFile()!)).toBe(true)
    const result = await runPublicPi({ purpose: 'evidence', input, apiKey: 'synthetic-key', connection: { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: { id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 } } }, {
      cwd, agentDir, authorize: async kind => { approvals.push(kind) }, stream: (model, context, options) => {
        observed.push(JSON.parse(JSON.stringify(context))); const stream = createAssistantMessageEventStream()
        void (async () => { payloads.push(await options?.onPayload?.({ model: model.id, store: true }, model)); const reply = observed.length === 1 ? message([{ type: 'toolCall', id: 'tool-1', name: 'get_public_block', arguments: { snapshotId: 'snapshot', blockId: 'block' } }], true) : message([{ type: 'text', text: '{"candidate":"synthetic"}' }]); stream.push({ type: 'start', partial: reply }); stream.push({ type: 'done', reason: reply.stopReason as 'stop' | 'toolUse', message: reply }) })().catch(() => stream.end())
        return stream
      },
    })
    expect(result).toBe('{"candidate":"synthetic"}'); expect(observed).toHaveLength(2)
    expect(observed[0]!.tools?.map(tool => tool.name)).toEqual(['get_public_block', 'get_public_evidence'])
    const body = JSON.stringify(observed)
    for (const secret of ['PRIVATE-ANCESTOR', 'PRIVATE-PROJECT', 'PRIVATE-MEMORY', 'PRIVATE-SDK-HISTORY', 'PRIVATE-EXTENSION', cwd]) expect(body).not.toContain(secret)
    expect(body).toContain('Synthetic evidence'); expect(payloads.every(payload => payload.store === false)).toBe(true)
    expect(approvals).toContain('model'); expect(approvals).toContain('tool'); expect(existsSync(marker)).toBe(false)
  } finally { const offset = relative(realpathSync.native(resolve('.fixtures')), realpathSync.native(root)); if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned public fixture boundary'); rmSync(root, { recursive: true, force: true }) }
})

test('a tool result that exceeds the selected model window stops before a second model request', async () => {
  let calls = 0
  const longInput = { ...input, blocks: [{ ...input.blocks[0]!, end: 16000, text: 'x'.repeat(16000) }] }
  const pending = runPublicPi({ purpose: 'evidence', input: longInput, apiKey: 'synthetic-key', connection: { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: { id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 } } }, {
    authorize: async () => {}, stream: () => {
      const stream = createAssistantMessageEventStream()
      const reply = ++calls === 1 ? message([{ type: 'toolCall', id: 'tool-budget', name: 'get_public_block', arguments: { snapshotId: 'snapshot', blockId: 'block' } }], true) : message([{ type: 'text', text: '{"candidate":"synthetic"}' }])
      stream.push({ type: 'start', partial: reply }); stream.push({ type: 'done', reason: reply.stopReason as 'stop' | 'toolUse', message: reply })
      return stream
    },
  })
  await expect(pending).rejects.toMatchObject({ code: 'BIO_MODEL_BUDGET' })
  expect(calls).toBe(1)
})
