import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { ResearchConnectionsService } from './model-connections'
import { CredentialManager } from '@craft-agent/shared/credentials'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace.mjs'
const admin = { userId: 'admin', authSessionId: 'auth-admin', active: true, administrator: true }, member = { userId: 'bob', authSessionId: 'auth-bob', active: true, administrator: false }, scope = { kind: 'personal', ownerId: 'bob' } as const
const configuration = { slug: 'official', name: 'Official', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', scopes: [scope], enabled: true, models: [{ id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 }] }
let repo: SqliteResearchRepository, service: ResearchConnectionsService, keys: Map<string, string>
beforeEach(() => {
  repo = new SqliteResearchRepository()
  for (const actor of [admin, member]) repo.seedUser({ id: actor.userId, username: actor.userId, passwordHash: 'synthetic', active: true, administrator: actor.administrator, revision: 1 })
  keys = new Map()
  service = new ResearchConnectionsService(repo, { getLlmApiKey: async id => keys.get(id) ?? null, setLlmApiKey: async (id, key) => { keys.set(id, key) }, deleteLlmApiKey: async id => keys.delete(id) })
})
afterEach(() => repo.close())
test('the real Bio encrypted credential manager roundtrips a selected connection without exposing the key', async () => {
  const manager = new CredentialManager(), production = new ResearchConnectionsService(repo, manager)
  try {
    const saved = await production.save(admin, { configuration, expectedRevision: 0, apiKey: 'synthetic-encrypted-connection-key' })
    expect(saved).toMatchObject({ slug: 'official', keyConfigured: true })
    const selected = production.broker.select(member, scope, 'official', 'synthetic-gpt')
    expect((await production.broker.credentials(member, scope, selected, () => {})).apiKey).toBe('synthetic-encrypted-connection-key')
    const reopened = new CredentialManager()
    expect(await reopened.getLlmApiKey(selected.credentialId!)).toBe('synthetic-encrypted-connection-key')
    expect(readFileSync(join(resolveConfigDir(), 'credentials.enc')).includes(Buffer.from('synthetic-encrypted-connection-key'))).toBe(false)
    expect(JSON.stringify(production.list(member, scope))).not.toContain('credentialId')
    expect(JSON.stringify(production.list(member, scope))).not.toContain('synthetic-encrypted-connection-key')
  } finally {
    const record = repo.managedResearchConnection(admin, 'official')
    if (record) await manager.deleteLlmApiKey(record.credentialId)
  }
})
test('only a current administrator configures connections; members select granted models without secret or config-owner access', async () => {
  const saved = await service.save(admin, { configuration, expectedRevision: 0, apiKey: 'synthetic-connection-key' })
  expect(saved).toMatchObject({ slug: 'official', revision: 1, keyConfigured: true })
  expect(JSON.stringify(saved)).not.toContain('synthetic-connection-key'); expect(saved).not.toHaveProperty('credentialId')
  expect(service.list(member, scope)).toHaveLength(1)
  expect(() => repo.get(member, 'connection', 'official')).toThrow()
  const selected = service.broker.select(member, scope, 'official', 'synthetic-gpt')
  expect((await service.broker.credentials(member, scope, selected, () => {})).apiKey).toBe('synthetic-connection-key')
  await expect(service.save(member, { configuration, expectedRevision: 1, apiKey: 'malicious-member-key' })).rejects.toThrow()
  expect(keys.size).toBe(1)
  expect(JSON.stringify(repo.get(admin, 'connection', 'official'))).not.toContain('synthetic-connection-key')
})
test('stale configuration is rejected before key staging and does not change active credentials', async () => {
  await service.save(admin, { configuration, expectedRevision: 0, apiKey: 'synthetic-original-key' })
  await expect(service.save(admin, { configuration, expectedRevision: 0, apiKey: 'synthetic-stale-key' })).rejects.toThrow()
  expect([...keys.values()]).toEqual(['synthetic-original-key'])
  await service.save(admin, { configuration, expectedRevision: 1, apiKey: 'synthetic-new-key' })
  const selected = service.broker.select(member, scope, 'official', 'synthetic-gpt')
  expect((await service.broker.credentials(member, scope, selected, () => {})).apiKey).toBe('synthetic-new-key')
})
test('a concurrent revision committed after key staging preserves the winning key and deletes only the losing staged key', async () => {
  await service.save(admin, { configuration, expectedRevision: 0, apiKey: 'synthetic-original-key' })
  let release!: () => void, staged!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), stagedReady = new Promise<void>(resolve => { staged = resolve })
  const concurrent = new ResearchConnectionsService(repo, {
    getLlmApiKey: async id => keys.get(id) ?? null,
    setLlmApiKey: async (id, value) => { keys.set(id, value); if (value === 'synthetic-losing-key') { staged(); await gate } },
    deleteLlmApiKey: async id => keys.delete(id),
  })
  const losing = concurrent.save(admin, { configuration, expectedRevision: 1, apiKey: 'synthetic-losing-key' })
  await stagedReady
  await concurrent.save(admin, { configuration, expectedRevision: 1, apiKey: 'synthetic-winning-key' })
  release()
  await expect(losing).rejects.toMatchObject({ code: 'BIO_REVISION_CONFLICT' })
  expect([...keys.values()].sort()).toEqual(['synthetic-original-key', 'synthetic-winning-key'])
  const selected = concurrent.broker.select(member, scope, 'official', 'synthetic-gpt')
  expect((await concurrent.broker.credentials(member, scope, selected, () => {})).apiKey).toBe('synthetic-winning-key')
})
test('account deactivation while a key is staged rejects the commit and cleans the staged key', async () => {
  const secondAdmin = { ...admin, userId: 'second-admin', authSessionId: 'auth-second-admin' }
  repo.seedUser({ id: secondAdmin.userId, username: secondAdmin.userId, passwordHash: 'synthetic', active: true, administrator: true, revision: 1 })
  const revoked = new ResearchConnectionsService(repo, {
    getLlmApiKey: async id => keys.get(id) ?? null,
    setLlmApiKey: async (id, value) => { keys.set(id, value); repo.setAccountActive(secondAdmin, admin.userId, false, 1) },
    deleteLlmApiKey: async id => keys.delete(id),
  })
  await expect(revoked.save(admin, { configuration, expectedRevision: 0, apiKey: 'synthetic-revoked-key' })).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' })
  expect(keys.size).toBe(0)
  expect(service.list(member, scope)).toEqual([])
})
test('connection metadata and failed mutation audits are scoped and contain no keys', async () => {
  await service.save(admin, { configuration, expectedRevision: 0, apiKey: 'synthetic-audit-key' })
  await expect(service.save(admin, { configuration, expectedRevision: 0, apiKey: 'synthetic-failed-key' })).rejects.toThrow()
  const audit = repo.readAudit(admin, { kind: 'personal', ownerId: 'admin' }, 200)
  expect(audit).toContainEqual(expect.objectContaining({ action: 'connection-save', outcome: 'success' }))
  expect(audit).toContainEqual(expect.objectContaining({ action: 'connection-save', outcome: 'failed' }))
  expect(JSON.stringify(audit)).not.toContain('synthetic-audit-key'); expect(JSON.stringify(audit)).not.toContain('synthetic-failed-key')
})
