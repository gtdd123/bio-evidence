import { expect, test } from 'bun:test'
import { createBackend, createBackendFromConnection } from '../factory'
import { PiAgent } from '../../pi-agent'
import { resolveConfigDir } from '../../../config/namespace.mjs'
import type { BackendConfig } from '../types'
test('public profile cannot reach general helpers, source activation or private workspace context', async () => {
  let calls = 0
  const runtime = { model: 'synthetic-gpt', connectionId: 'synthetic', approvedInput: 'approved-operation', assertCurrent: () => {}, abort: async () => {}, stream: async function* () { calls++; yield { type: 'complete' as const } } }
  const config = { provider: 'pi', model: runtime.model, connectionSlug: runtime.connectionId, executionProfile: 'public-research', publicResearchRuntime: runtime,
    workspace: { id: 'workspace', slug: 'workspace', name: 'PRIVATE-WORKSPACE', rootPath: resolveConfigDir(), createdAt: 1 }, isHeadless: true, skipConfigWatcher: true } as BackendConfig
  const backend = createBackend(config)
  try {
    expect(backend.constructor.name).toBe('PublicResearchBackend')
    expect(() => new PiAgent(config)).toThrow('isolated backend')
    const fromConnection = createBackendFromConnection(runtime.connectionId, config)
    expect(fromConnection.constructor.name).toBe('PublicResearchBackend'); fromConnection.destroy()
    expect(() => createBackendFromConnection('other-connection', config)).toThrow()
    await expect(backend.runMiniCompletion('PRIVATE-HELPER')).rejects.toThrow()
    await expect(backend.getSummarizeCallback()('PRIVATE-SUMMARY')).rejects.toThrow()
    expect(() => backend.setSourceServers({ private: { type: 'stdio', command: 'PRIVATE-COMMAND' } }, {})).toThrow()
    expect(() => backend.setAllSources([{ slug: 'private' } as any])).toThrow()
    expect(() => backend.updateWorkingDirectory('PRIVATE-MATERIALS')).toThrow()
    backend.setPermissionMode('allow-all'); expect(backend.getPermissionMode()).toBe('safe')
    expect(await backend.generateTitle('PRIVATE-TITLE')).toBe('公开文献调研')
    await expect((async () => { for await (const _ of backend.chat('PRIVATE-FORGED')) {} })()).rejects.toThrow()
    expect(calls).toBe(0)
    for await (const _ of backend.chat(runtime.approvedInput)) {}
    expect(calls).toBe(1)
    await expect((async () => { for await (const _ of backend.chat(runtime.approvedInput)) {} })()).rejects.toThrow()
  } finally { backend.destroy() }
})
