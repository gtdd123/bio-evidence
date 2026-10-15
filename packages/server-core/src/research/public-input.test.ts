import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { PublicInputService, ResearchConnectionBroker } from './public-input'
import { ArtifactsService } from './artifacts-service'
const actor = { userId: 'alice', authSessionId: 'auth-alice', active: true, administrator: false }, scope = { kind: 'personal', ownerId: 'alice' } as const
const request = { sessionId: 'session', connectionId: 'official', model: 'synthetic-gpt', question: 'Public research question', declaredPublic: true, blocks: [{ snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18 }], evidenceRevisionIds: [] }
let repo: SqliteResearchRepository, service: PublicInputService, broker: ResearchConnectionBroker, connections: any[], keyReads: string[]
beforeEach(() => {
  repo = new SqliteResearchRepository(); repo.seedUser({ id: 'alice', username: 'alice', passwordHash: 'synthetic', active: true, administrator: false, revision: 1 })
  repo.put(actor, 'source', { id: 'source', scope, policy: 'public', provider: 'pdf-import', identifiers: {}, title: 'Synthetic paper', license: { status: 'unknown' }, createdAt: 1 })
  repo.put(actor, 'snapshot', { id: 'snapshot', sourceId: 'source', scope, policy: 'public', license: { status: 'unknown' }, format: 'pdf', acquiredBy: 'declared-public-pdf', retrievedAt: 1, contentHash: 'a'.repeat(64), coverage: { level: 'full', totalUnits: 1, units: [{ unit: 1, status: 'read' }] }, blocks: [{ id: 'block', unit: 1, text: 'Synthetic evidence', locator: { kind: 'pdf-page', page: 1 } }] })
  repo.put(actor, 'session', { id: 'session', ownerId: 'alice', scope, name: 'PRIVATE-TITLE-MUST-NOT-LEAVE', policy: 'public', selectedSourceIds: ['source'], revision: 1, createdAt: 1 })
  connections = [{ slug: 'official', name: 'Official', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', enabled: true, revision: 1, scopes: [scope], models: [{ id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 }] }]
  keyReads = []; broker = new ResearchConnectionBroker(repo, () => connections, async slug => { keyReads.push(slug); return 'synthetic-api-key-only' })
  service = new PublicInputService(repo, broker)
})
afterEach(() => repo.close())
test('server builds a frozen public input from saved blocks and excludes ambient private state', async () => {
  const prepared = service.prepare(actor, request)
  expect(prepared.modelInput.blocks[0]!.text).toBe('Synthetic evidence')
  expect(prepared.modelInput.question).toBe(request.question)
  expect(JSON.stringify(prepared.modelInput)).not.toContain('PRIVATE-TITLE-MUST-NOT-LEAVE')
  expect(JSON.stringify(prepared.modelInput)).not.toContain('alice')
  expect(Object.isFrozen(prepared.modelInput.blocks)).toBe(true)
  expect(keyReads).toEqual([])
  expect((await broker.credentials(actor, scope, prepared.connection, prepared.assertCurrent)).apiKey).toBe('synthetic-api-key-only')
  expect(keyReads).toEqual(['official'])
})
test('private, unknown, forged or unselected inputs stop before any credential or model call', () => {
  for (const raw of [{ ...request, declaredPublic: false }, { ...request, public: true }, { ...request, history: [{ text: 'PRIVATE-HISTORY' }] }, { ...request, blocks: [{ ...request.blocks[0], text: 'FORGED' }] }]) expect(() => service.prepare(actor, raw)).toThrow()
  const session = repo.get(actor, 'session', 'session')
  repo.put(actor, 'session', { ...session, policy: 'unknown', revision: 2 }, 1)
  expect(() => service.prepare(actor, request)).toThrow(); expect(keyReads).toEqual([])
})
test('an actual abstract snapshot keeps its abstract coverage in the public manifest', () => {
  repo.put(actor, 'snapshot', { ...repo.get(actor, 'snapshot', 'snapshot'), id: 'abstract-snapshot', format: 'abstract', acquiredBy: 'europe-pmc-abstract', coverage: { level: 'abstract', totalUnits: 1, units: [{ unit: 1, status: 'read' }] }, blocks: [{ id: 'abstract-block', unit: 1, text: 'Synthetic abstract', locator: { kind: 'abstract' } }] })
  const prepared = service.prepare(actor, { ...request, blocks: [{ snapshotId: 'abstract-snapshot', blockId: 'abstract-block', start: 0, end: 18 }] })
  expect(prepared.modelInput.blocks[0]!.coverage).toBe('abstract')
})
test('unclassified persisted session history is refused even when the session label is public', () => {
  repo.appendProjection(actor, 'session', 'legacy-private-history', [{ id: 'old-message', role: 'user', content: 'PRIVATE-PERSISTED-HISTORY', timestamp: 1 }], 1)
  expect(() => service.prepare(actor, request)).toThrow('cannot be sent to a cloud model')
  expect(keyReads).toEqual([])
})
test('a later source restriction and disabled connection invalidate previously prepared inputs', async () => {
  const prepared = service.prepare(actor, request), source = repo.get(actor, 'source', 'source')
  repo.put(actor, 'source', { ...source, id: 'source-private', sourceIdentityId: 'source', predecessorId: 'source', revision: 2, policy: 'restricted', createdAt: 2 }, 1)
  expect(() => prepared.assertCurrent()).toThrow()
  await expect(broker.credentials(actor, scope, prepared.connection, prepared.assertCurrent)).rejects.toThrow()
  expect(keyReads).toEqual([])
})
test('selected connection and model are exact with no default, endpoint or credential fallback', async () => {
  expect(() => service.prepare(actor, { ...request, connectionId: 'missing' })).toThrow()
  expect(() => service.prepare(actor, { ...request, model: 'other-model' })).toThrow()
  const prepared = service.prepare(actor, request)
  connections[0].enabled = false
  await expect(broker.credentials(actor, scope, prepared.connection, prepared.assertCurrent)).rejects.toThrow()
  connections[0].enabled = true; connections[0].baseUrl = 'https://unapproved.invalid/v1'
  expect(() => service.prepare(actor, request)).toThrow()
  expect(keyReads).toEqual([])
})
test('compatibility label never grants private access and all selected context has a hard budget', () => {
  connections[0] = { ...connections[0], slug: 'local', name: 'Local', providerType: 'pi_compat', piAuthProvider: undefined, baseUrl: 'https://compat.invalid/v1', customEndpoint: { api: 'openai-completions' } }
  const compatible = service.prepare(actor, { ...request, connectionId: 'local' })
  expect(compatible.connection.api).toBe('openai-completions')
  expect(() => service.prepare(actor, { ...request, connectionId: 'local', question: 'x'.repeat(32001) })).toThrow()
  repo.put(actor, 'session', { ...repo.get(actor, 'session', 'session'), policy: 'restricted', revision: 2 }, 1)
  expect(() => service.prepare(actor, { ...request, connectionId: 'local' })).toThrow()
})

test('oversized first evidence stops before reading subsequent evidence or model credentials', () => {
  const artifacts = new ArtifactsService(repo), citation = { snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18, quote: 'Synthetic evidence' }
  const first = artifacts.createEvidence(actor, { sessionId: 'session', claim: 'x'.repeat(16000), factSummary: 'y'.repeat(16000), limitations: 'z'.repeat(16000), citations: [citation], declaredPublic: true })
  const second = artifacts.createEvidence(actor, { sessionId: 'session', claim: 'Must not read this evidence', citations: [citation], declaredPublic: true })
  const original = repo.get.bind(repo), reads: string[] = []
  const read = spyOn(repo, 'get').mockImplementation((current, kind, id) => {
    if (kind === 'evidence') { reads.push(id); if (id === second.id) throw Error('Must not read subsequent evidence') }
    return original(current, kind, id)
  })
  try {
    expect(() => service.prepare(actor, { ...request, evidenceRevisionIds: [first.id, second.id] })).toThrow(expect.objectContaining({ code: 'BIO_MODEL_BUDGET' }))
    expect(reads).not.toContain(second.id); expect(keyReads).toEqual([])
  } finally { read.mockRestore() }
})

test('cumulative selected excerpts stop at the budget before reading another snapshot', () => {
  repo.put(actor, 'snapshot', { ...repo.get(actor, 'snapshot', 'snapshot'), id: 'large-snapshot', blocks: [{ id: 'large-block', unit: 1, text: 'x'.repeat(36000), locator: { kind: 'pdf-page', page: 1 } }] })
  const original = repo.get.bind(repo), reads: string[] = []
  const read = spyOn(repo, 'get').mockImplementation((current, kind, id) => {
    if (kind === 'snapshot') { reads.push(id); if (id === 'must-not-read') throw Error('Must not read subsequent snapshot') }
    return original(current, kind, id)
  })
  try {
    expect(() => service.prepare(actor, { ...request, blocks: [{ snapshotId: 'large-snapshot', blockId: 'large-block', start: 0, end: 18000 }, { snapshotId: 'large-snapshot', blockId: 'large-block', start: 18000, end: 36000 }, { snapshotId: 'must-not-read', blockId: 'block', start: 0, end: 1 }] })).toThrow(expect.objectContaining({ code: 'BIO_MODEL_BUDGET' }))
    expect(reads).not.toContain('must-not-read'); expect(keyReads).toEqual([])
  } finally { read.mockRestore() }
})
