import { expect, test } from 'bun:test'
import { PublicModelWorkerService } from './public-model-worker'
import type { PreparedPublicInput } from './public-input'
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { join, relative, sep, isAbsolute } from 'node:path'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace.mjs'
const modelInput = { question: 'Public question', readingScope: 'selected-excerpts-only' as const, blocks: [{ snapshotId: 'snapshot', sourceId: 'source', blockId: 'block', start: 0, end: 18, text: 'Synthetic evidence', locator: { kind: 'abstract' as const }, coverage: 'abstract' as const, totalUnits: 1, selectedUnit: 1, identifiers: {}, metadataPending: false, contentHash: 'a'.repeat(64) }], evidence: [] }
const prepared: PreparedPublicInput = { manifest: { id: 'synthetic', sessionId: 'synthetic', sessionRevision: 1, scope: { kind: 'personal', ownerId: 'synthetic' }, actorId: 'synthetic', declaredAt: 1, policyVersion: 1, contextHash: 'a'.repeat(64), connectionId: 'synthetic', model: 'synthetic-gpt' }, modelInput,
  connection: { slug: 'synthetic', revision: 1, fingerprint: 'synthetic', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: { id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 } }, assertCurrent: () => {} }
test('actual isolated worker constructs SDK with no inherited provider keys and exits before returning', async () => {
  const runner = new PublicModelWorkerService(), previous = process.env.OPENAI_API_KEY
  try {
    process.env.OPENAI_API_KEY = 'synthetic-must-not-inherit'
    const result = JSON.parse(await runner.run(prepared, 'evidence', 'synthetic-selected-key', undefined, 'inspect'))
    expect(result).toMatchObject({ model: 'synthetic-gpt', messages: 0, inheritedProviderKey: false, tools: ['get_public_block', 'get_public_evidence'] })
    expect(runner.activeProcessIds).toEqual([])
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; await runner.close() }
}, 20000)
test('revoked prepared input stops before child creation', async () => {
  const runner = new PublicModelWorkerService()
  try { await expect(runner.run({ ...prepared, assertCurrent: () => { throw Error('Denied') } }, 'evidence', 'synthetic-key', undefined, 'inspect')).rejects.toThrow(); expect(runner.activeProcessIds).toEqual([]) }
  finally { await runner.close() }
})
test('timeout, cancellation and close terminate actual worker processes and await cleanup', async () => {
  const runner = new PublicModelWorkerService({ timeoutMs: 100 }), controller = new AbortController()
  try {
    const timed = runner.run(prepared, 'evidence', 'synthetic-key', undefined, 'inspect'), pid = runner.activeProcessIds[0]!
    await expect(timed).rejects.toMatchObject({ code: 'BIO_MODEL_TIMEOUT' }); expect(() => process.kill(pid, 0)).toThrow()
    const cancelled = runner.run(prepared, 'evidence', 'synthetic-key', controller.signal, 'inspect'), cancelledPid = runner.activeProcessIds[0]!
    controller.abort(); await expect(cancelled).rejects.toMatchObject({ code: 'BIO_MODEL_CANCELLED' }); expect(() => process.kill(cancelledPid, 0)).toThrow()
    const running = runner.run(prepared, 'evidence', 'synthetic-key', undefined, 'inspect'), activePid = runner.activeProcessIds[0]!
    const rejection = expect(running).rejects.toThrow()
    await runner.close(); await rejection
    expect(() => process.kill(activePid, 0)).toThrow(); expect(runner.activeProcessIds).toEqual([])
  } finally { controller.abort(); await runner.close() }
})

test('worker error frames preserve only approved error codes and reject extra provider content', async () => {
  const parent = realpathSync.native(resolveConfigDir()), root = mkdtempSync(join(parent, 'public-worker-contract-')), worker = join(root, 'worker.ts')
  try {
    for (const frame of [{ type: 'error', code: 'BIO_MODEL_AUTH_FAILED' }, { type: 'error', code: 'BIO_MODEL_AUTH_FAILED', body: 'PRIVATE-PROVIDER-BODY' }]) {
      writeFileSync(worker, `await Bun.stdin.stream().getReader().read(); process.stdout.write(${JSON.stringify(JSON.stringify(frame) + '\n')}); process.exit(1)`)
      const runner = new PublicModelWorkerService({ workerPath: worker })
      try {
        await expect(runner.run(prepared, 'evidence', 'synthetic-selected-key')).rejects.toMatchObject({ code: 'body' in frame ? 'BIO_INPUT_INVALID' : 'BIO_MODEL_AUTH_FAILED' })
        expect(runner.activeProcessIds).toEqual([])
      } finally { await runner.close() }
    }
  } finally {
    const target = realpathSync.native(root), offset = relative(parent, target)
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned worker fixture boundary')
    rmSync(target, { recursive: true, force: true })
  }
})
