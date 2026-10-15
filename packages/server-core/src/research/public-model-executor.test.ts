import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { PublicInputService, ResearchConnectionBroker } from './public-input'
import { PublicModelExecutor } from './public-model-executor'
const actor = { userId: 'alice', authSessionId: 'auth-alice', active: true, administrator: false }, scope = { kind: 'personal', ownerId: 'alice' } as const
const request = { sessionId: 'session', connectionId: 'official', model: 'synthetic-gpt', question: 'Public question', declaredPublic: true, blocks: [{ snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18 }] }
let repo: SqliteResearchRepository, executor: PublicModelExecutor, answer: string, calls: number
beforeEach(() => {
  repo = new SqliteResearchRepository(); repo.seedUser({ id: 'alice', username: 'alice', passwordHash: 'synthetic', active: true, administrator: false, revision: 1 })
  repo.put(actor, 'source', { id: 'source', scope, policy: 'public', provider: 'pdf-import', identifiers: {}, license: { status: 'unknown' }, createdAt: 1 })
  repo.put(actor, 'snapshot', { id: 'snapshot', sourceId: 'source', scope, policy: 'public', license: { status: 'unknown' }, format: 'abstract', acquiredBy: 'europe-pmc-abstract', retrievedAt: 1, contentHash: 'a'.repeat(64), coverage: { level: 'abstract', totalUnits: 1, units: [{ unit: 1, status: 'read' }] }, blocks: [{ id: 'block', unit: 1, text: 'Synthetic evidence', locator: { kind: 'abstract' } }] })
  repo.put(actor, 'session', { id: 'session', ownerId: 'alice', scope, name: 'Research', policy: 'public', selectedSourceIds: ['source'], revision: 1, createdAt: 1 })
  const broker = new ResearchConnectionBroker(repo, () => [{ slug: 'official', name: 'Official', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', enabled: true, revision: 1, scopes: [scope], models: [{ id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 }] }], async () => 'synthetic-key')
  calls = 0; answer = JSON.stringify({ claim: 'A scientific claim that still needs human judgement.', citations: [{ snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18, quote: 'Synthetic evidence' }] })
  executor = new PublicModelExecutor(repo, new PublicInputService(repo, broker), broker, { run: async () => { calls++; return answer } })
})
afterEach(() => repo.close())
test('factory public profile returns validated candidate with no automatic scientific confirmation or save', async () => {
  const result = await executor.generate(actor, request, 'evidence')
  expect(result).toMatchObject({ kind: 'evidence', structuralStatus: 'structure-valid', reviewStatus: 'unreviewed' })
  expect(calls).toBe(1); expect(repo.listArtifactHeads(actor, 'session', 200).items).toEqual([])
})
test('malformed JSON, fake review and unknown references are rejected; mismatched excerpts remain pending', async () => {
  for (const value of ['not-json', JSON.stringify({ ...JSON.parse(answer), reviewStatus: 'confirmed' }), JSON.stringify({ claim: 'Unknown reference', citations: [{ snapshotId: 'private', blockId: 'secret', start: 0, end: 3, quote: 'bad' }] })]) {
    const previous = answer; answer = value; await expect(executor.generate(actor, request, 'evidence')).rejects.toThrow(); answer = previous
  }
  answer = answer.replace('Synthetic evidence', 'Fabricated excerpt')
  expect(await executor.generate(actor, request, 'evidence')).toMatchObject({ structuralStatus: 'pending', reviewStatus: 'unreviewed' })
})
test('private context prevents execution and operation audits contain no prompt or response text', async () => {
  await executor.generate(actor, request, 'evidence')
  repo.put(actor, 'session', { ...repo.get(actor, 'session', 'session'), policy: 'restricted', revision: 2 }, 1)
  await expect(executor.generate(actor, request, 'evidence')).rejects.toThrow(); expect(calls).toBe(1)
  const audit = repo.readAudit(actor, scope, 200)
  expect(audit).toContainEqual(expect.objectContaining({ action: 'research-model-evidence-finished', outcome: 'success' }))
  expect(audit).toContainEqual(expect.objectContaining({ action: 'research-model-evidence-finished', outcome: 'failed' }))
  expect(JSON.stringify(audit)).not.toContain('Public question'); expect(JSON.stringify(audit)).not.toContain('scientific claim')
})
