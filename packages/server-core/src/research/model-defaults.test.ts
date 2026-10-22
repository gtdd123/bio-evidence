import { expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { ResearchConnectionsService } from './model-connections'
const admin = { userId: 'admin', authSessionId: 'bootstrap', active: true, administrator: true }
test('default gateway connections initialize once, stay scoped, and never return environment secrets', async () => {
  const repo = new SqliteResearchRepository(), keys = new Map<string, string>()
  repo.seedUser({ id: 'admin', username: 'admin', passwordHash: 'synthetic', active: true, administrator: true, revision: 1 })
  const service = new ResearchConnectionsService(repo, { getLlmApiKey: async id => keys.get(id) ?? null, setLlmApiKey: async (id, key) => { keys.set(id, key) }, deleteLlmApiKey: async id => keys.delete(id) })
  try {
    await service.initializeDefaults(admin, { OPENAI_API_KEY: 'synthetic-openai-secret', DEEPSEEK_API_KEY: 'synthetic-deepseek-secret' })
    const scope = { kind: 'personal', ownerId: 'admin' } as const, choices = service.list(admin, scope)
    expect(choices).toHaveLength(2)
    expect(choices.map(item => [item.slug, item.baseUrl, item.api])).toEqual([
      ['deepseek-default', 'https://api.deepseek.com/v1', 'openai-completions'], ['openai-default', 'https://api.openai.com/v1', 'openai-responses'],
    ])
    expect(JSON.stringify(choices)).not.toContain('synthetic-')
    await service.initializeDefaults(admin, { OPENAI_API_KEY: 'replacement-secret', DEEPSEEK_API_KEY: 'replacement-secret' })
    expect(keys.size).toBe(2); expect(service.list(admin, scope)).toEqual(choices)
    expect(repo.managedResearchConnection(admin, 'openai-default')!.scopes).toEqual([scope])
  } finally { repo.close() }
})
test('invalid or inactive bootstrap actors cannot persist keys; compatible endpoints require HTTPS', async () => {
  const repo = new SqliteResearchRepository(), keys = new Map<string, string>()
  const service = new ResearchConnectionsService(repo, { getLlmApiKey: async id => keys.get(id) ?? null, setLlmApiKey: async (id, key) => { keys.set(id, key) }, deleteLlmApiKey: async id => keys.delete(id) })
  try {
    await expect(service.initializeDefaults(admin, { OPENAI_API_KEY: 'synthetic-secret' })).rejects.toThrow()
    expect(keys.size).toBe(0)
    repo.seedUser({ id: 'admin', username: 'admin', passwordHash: 'synthetic', active: true, administrator: true, revision: 1 })
    await expect(service.initializeDefaults(admin, { OPENAI_API_KEY: 'synthetic-secret', OPENAI_API_BASE_URL: 'http://192.168.1.20:8000/v1' })).rejects.toThrow()
    expect(keys.size).toBe(0)
    await service.initializeDefaults(admin, { LAB_API_KEY: 'synthetic-lab-key', LAB_API_BASE_URL: 'https://gpu.lab.example/v1', LAB_MODEL: 'Qwen2.5-72B-Instruct' })
    expect(service.list(admin, { kind: 'personal', ownerId: 'admin' })[0]).toMatchObject({ deployment: 'lab', api: 'openai-completions', models: [{ id: 'Qwen2.5-72B-Instruct' }] })
  } finally { repo.close() }
})

test('startup can initialize from explicitly named Bio credential slots, and skips inactive administrators', async () => {
  const repo = new SqliteResearchRepository(), keys = new Map([['openai-default','synthetic-vault-secret']])
  const service = new ResearchConnectionsService(repo, { getLlmApiKey: async id => keys.get(id) ?? null, setLlmApiKey: async (id, value) => { keys.set(id, value) }, deleteLlmApiKey: async id => keys.delete(id) })
  try {
    expect(repo.bootstrapResearchAdministrator()).toBeUndefined()
    repo.seedUser({ id: 'inactive', username: 'inactive', passwordHash: 'synthetic', active: false, administrator: true, revision: 1 })
    expect(repo.bootstrapResearchAdministrator()).toBeUndefined()
    await expect(service.initializeDefaults({ ...admin, userId: 'inactive' }, {})).rejects.toThrow()
    expect(keys.size).toBe(1)
    repo.seedUser({ id: 'admin', username: 'admin', passwordHash: 'synthetic', active: true, administrator: true, revision: 1 })
    await service.initializeDefaults(admin, {})
    expect(service.list(admin, { kind: 'personal', ownerId: 'admin' })).toHaveLength(1)
    expect(JSON.stringify(service.list(admin, { kind: 'personal', ownerId: 'admin' }))).not.toContain('synthetic-vault-secret')
  } finally { repo.close() }
})
