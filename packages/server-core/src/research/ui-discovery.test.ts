import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { ArtifactsService } from './artifacts-service'
import { ResearchConnectionsService } from './model-connections'
import { SourceSnapshotService } from './source-snapshots'
import { LiteratureService } from './literature-service'
import { DocumentParseService } from './document-parse'
import { createBioAuthorityServer } from './authority-server'
import { registerResearchRpcProfile } from './rpc-profile'

const alice = { userId: 'alice', authSessionId: 'auth-alice', active: true, administrator: true }
const bob = { userId: 'bob', authSessionId: 'auth-bob', active: true, administrator: false }
const scope = { kind: 'project', projectId: 'project' } as const
let repo: SqliteResearchRepository, artifacts: ArtifactsService, connections: ResearchConnectionsService
let profile: ReturnType<typeof registerResearchRpcProfile>, snapshots: SourceSnapshotService
let authority: Awaited<ReturnType<typeof createBioAuthorityServer>>
const call = (actor: typeof alice, name: string, input: unknown) => profile.dispatch(actor, `research:v1:${name}` as any, input, current => current)
beforeEach(async () => {
  repo = new SqliteResearchRepository()
  for (const actor of [alice, bob]) repo.seedUser({ id: actor.userId, username: actor.userId, passwordHash: 'synthetic', active: true, administrator: actor.administrator, revision: 1 })
  repo.createProject(alice, 'project', 'Synthetic project'); repo.setMember(alice, 'project', 'bob', 'viewer', true, 1)
  repo.put(alice, 'session', { id: 'session', scope, ownerId: 'alice', name: 'Synthetic session', policy: 'public', revision: 1, createdAt: 1 })
  repo.put(alice, 'source', { id: 'source', scope, policy: 'public', provider: 'pdf-import', identifiers: {}, license: { status: 'unknown' }, createdAt: 1 })
  for (const id of ['snapshot-a', 'snapshot-b']) repo.put(alice, 'snapshot', { id, sourceId: 'source', scope, policy: 'public', license: { status: 'unknown' }, format: 'pdf', acquiredBy: 'declared-public-pdf', retrievedAt: 1, contentHash: 'a'.repeat(64),
    coverage: { level: 'full', totalUnits: 1, units: [{ unit: 1, status: 'read' }] }, blocks: [{ id: 'block', unit: 1, text: 'Synthetic excerpt', locator: { kind: 'pdf-page', page: 1 } }] })
  artifacts = new ArtifactsService(repo)
  const literature = new LiteratureService(repo, { search: async () => ({ items: [] }), record: async () => { throw Error('unused') }, openText: async () => { throw Error('unused') } })
  snapshots = new SourceSnapshotService(repo, literature, new DocumentParseService())
  const keys = new Map<string, string>()
  connections = new ResearchConnectionsService(repo, { getLlmApiKey: async id => keys.get(id) ?? null, setLlmApiKey: async (id, key) => { keys.set(id, key) }, deleteLlmApiKey: async id => keys.delete(id) })
  authority = await createBioAuthorityServer(repo, { port: 0 })
  profile = registerResearchRpcProfile(authority.server, repo, undefined, undefined, literature, snapshots, artifacts, connections)
})
afterEach(async () => { authority.server.close(); await snapshots.close(); repo.close() })

test('source snapshots are rediscoverable after reconnect through bounded metadata pages', async () => {
  const first = await call(bob, 'listSourceSnapshots', { sourceId: 'source', pageSize: 1 }) as any
  expect(first.items).toHaveLength(1); expect(first.items[0]).toMatchObject({ id: 'snapshot-a', sourceId: 'source', readUnits: 1, totalUnits: 1 })
  expect(first.items[0]).not.toHaveProperty('blocks'); expect(JSON.stringify(first)).not.toContain('Synthetic excerpt')
  const next = await call(bob, 'listSourceSnapshots', { sourceId: 'source', pageSize: 1, cursor: first.nextCursor }) as any
  expect(next.items.map((item: any) => item.id)).toEqual(['snapshot-b']); expect(next.nextCursor).toBeUndefined()
  expect((await call(bob, 'getSnapshot', { snapshotId: next.items[0].id }) as any).blocks[0].text).toBe('Synthetic excerpt')
  await expect(call(bob, 'listSourceSnapshots', { sourceId: 'source', pageSize: 101 })).rejects.toMatchObject({ code: 'BIO_INPUT_INVALID' })
  expect(() => profile.gate.authorizeResponse(bob, 'research:v1:listSourceSnapshots', [{ sourceId: 'source', pageSize: 1 }], { ...first, items: [{ ...first.items[0], secret: 'forged' }] })).toThrow()
  repo.setMember(alice, 'project', 'bob', 'viewer', false, 2)
  await expect(call(bob, 'listSourceSnapshots', { sourceId: 'source' })).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' })
  expect(() => profile.gate.authorizeResponse(bob, 'research:v1:listSourceSnapshots', [{ sourceId: 'source', pageSize: 1 }], first)).toThrow()
})

test('revision history discovers the exact family including reviewed older revisions without full bodies', async () => {
  const citation = { snapshotId: 'snapshot-a', blockId: 'block', start: 0, end: 17, quote: 'Synthetic excerpt' }
  const old = artifacts.createEvidence(alice, { sessionId: 'session', claim: 'Old claim', citations: [citation], declaredPublic: true })
  artifacts.review(alice, { kind: 'evidence', revisionId: old.id, expectedRevision: 1, decision: 'confirmed' })
  const current = artifacts.saveEvidence(alice, { evidenceId: old.evidenceId, expectedRevision: 1, claim: 'New claim', citations: [citation], declaredPublic: true })
  const request = { kind: 'evidence', entityId: old.evidenceId, pageSize: 1 }
  const page = await call(bob, 'listArtifactRevisions', request) as any
  expect(page.items.map((item: any) => [item.value.id, item.value.reviewStatus])).toEqual([[old.id, 'confirmed']])
  expect(page.items[0].value).not.toHaveProperty('citations')
  const next = await call(bob, 'listArtifactRevisions', { ...request, cursor: page.nextCursor }) as any
  expect(next.items[0].value.id).toBe(current.id); expect(next.nextCursor).toBeUndefined()
  const other = artifacts.createEvidence(alice, { sessionId: 'session', claim: 'Other family', citations: [citation] })
  await expect(call(bob, 'listArtifactRevisions', { ...request, cursor: other.id })).rejects.toMatchObject({ code: 'BIO_INPUT_INVALID' })
  expect(() => profile.gate.authorizeResponse(bob, 'research:v1:listArtifactRevisions', [request], next)).toThrow()
})

test('only the creating administrator can reload complete nonsecret model configuration including disabled connections', async () => {
  const configuration = { slug: 'official', name: 'Synthetic official', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', enabled: false, scopes: [scope, { kind: 'personal', ownerId: 'alice' }], models: [{ id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 }] }
  await connections.save(alice, { configuration, expectedRevision: 0, apiKey: 'synthetic-private-key' })
  const view = await call(alice, 'getModelConnectionConfiguration', { connectionId: 'official' }) as any
  expect(view).toEqual({ configuration, revision: 1, keyConfigured: true })
  expect(JSON.stringify(view)).not.toContain('synthetic-private-key'); expect(JSON.stringify(view)).not.toContain('credentialId')
  await expect(call(bob, 'getModelConnectionConfiguration', { connectionId: 'official' })).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' })
  repo.seedUser({ id: 'other-admin', username: 'other-admin', passwordHash: 'synthetic', active: true, administrator: true, revision: 1 })
  await expect(call({ ...alice, userId: 'other-admin' }, 'getModelConnectionConfiguration', { connectionId: 'official' })).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' })
  expect(() => profile.gate.authorizeResponse(alice, 'research:v1:getModelConnectionConfiguration', [{ connectionId: 'official' }], { ...view, credentialId: 'forged' })).toThrow()
})
