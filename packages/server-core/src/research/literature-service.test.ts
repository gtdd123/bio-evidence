import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { LiteratureService } from './literature-service'
import type { LiteratureProvider, LiteratureRecord } from './literature-provider'
const actor = { userId: 'alice', authSessionId: 'auth-alice', active: true, administrator: false }
const scope = { kind: 'personal', ownerId: 'alice' } as const
const article: LiteratureRecord = { provider: 'europe-pmc', providerId: 'MED:123', identifiers: { pmid: '123', doi: '10.1234/public' }, title: 'Public paper', abstract: 'Actual retrieved abstract.', license: { status: 'unknown' }, availability: { abstract: true, fullText: false } }
let repo: SqliteResearchRepository, service: LiteratureService, calls: number, records: LiteratureRecord[], now: number
beforeEach(() => {
  repo = new SqliteResearchRepository(); repo.seedUser({ id: 'alice', username: 'alice', passwordHash: 'synthetic', active: true, administrator: false, revision: 1 })
  repo.put(actor, 'session', { id: 'session-a', ownerId: 'alice', scope, policy: 'public', name: 'Research', revision: 1, createdAt: 1 })
  calls = 0; now = 1000; records = [article]
  const provider: LiteratureProvider = { search: async () => { calls++; return { items: records } }, record: async () => article, openText: async () => new Uint8Array() }
  service = new LiteratureService(repo, provider, { now: () => now })
})
afterEach(() => repo.close())
test('selection transaction rolls back source and snapshot if the session write fails', async () => {
  const candidate = (await service.search(actor, { sessionId: 'session-a', query: 'public' })).items[0]!
  const db = (repo as unknown as { db: import('bun:sqlite').Database }).db
  db.exec("CREATE TRIGGER reject_selection BEFORE UPDATE ON entities WHEN NEW.kind='session' BEGIN SELECT RAISE(ABORT, 'synthetic'); END")
  const before = repo.counts().outbox
  expect(() => service.select(actor, { sessionId: 'session-a', candidateId: candidate.id, expectedRevision: 1 })).toThrow()
  expect(repo.sourceHeads(actor, scope)).toHaveLength(0); expect(repo.counts().outbox).toBe(before)
  expect(repo.get(actor, 'session', 'session-a')).toMatchObject({ revision: 1 })
})
test('expired candidates and identical restricted PDF bytes cannot be promoted', async () => {
  const candidate = (await service.search(actor, { sessionId: 'session-a', query: 'public' })).items[0]!
  now += 900000
  expect(() => service.select(actor, { sessionId: 'session-a', candidateId: candidate.id, expectedRevision: 1 })).toThrow()
  const bytes = new TextEncoder().encode('%PDF-1.7 private repeated')
  service.registerPdf(actor, { sessionId: 'session-a', expectedRevision: 1, bytes })
  expect(() => service.registerPdf(actor, { sessionId: 'session-a', expectedRevision: 2, bytes, declaredPublic: true })).toThrow()
})
test('logout during provider await refuses the late result', async () => {
  let release!: () => void, live = true
  const pending = new Promise<void>(resolve => { release = resolve })
  const delayed = new LiteratureService(repo, { search: async () => { await pending; return { items: [article] } }, record: async () => article, openText: async () => new Uint8Array() },
    { currentActor: current => { if (!live) throw Error('revoked synthetic session'); return current } })
  const result = delayed.search(actor, { sessionId: 'session-a', query: 'public' }); live = false; release()
  await expect(result).rejects.toThrow()
})
test('same PDF bytes and policy reuse the existing source record', () => {
  const bytes = new TextEncoder().encode('%PDF-1.7 synthetic repeated')
  const first = service.registerPdf(actor, { sessionId: 'session-a', expectedRevision: 1, bytes })
  const second = service.registerPdf(actor, { sessionId: 'session-a', expectedRevision: 2, bytes })
  expect(second.source.id).toBe(first.source.id); expect(second.created).toBe(false)
})
test('new metadata without an abstract does not relabel old text as a new retrieval', async () => {
  const first = service.select(actor, { sessionId: 'session-a', candidateId: (await service.search(actor, { sessionId: 'session-a', query: 'old' })).items[0]!.id, expectedRevision: 1 })
  const { abstract, ...withoutAbstract } = article
  records = [{ ...withoutAbstract, title: 'New title', availability: { abstract: false, fullText: false } }]; now++
  const second = service.select(actor, { sessionId: 'session-a', candidateId: (await service.search(actor, { sessionId: 'session-a', query: 'new' })).items[0]!.id, expectedRevision: 2 })
  if (first.status !== 'selected' || second.status !== 'selected') throw Error('unexpected identity conflict')
  expect(second.source.abstract).toBeUndefined(); expect(second.snapshot).toBeUndefined()
  expect(repo.get(actor, 'snapshot', first.snapshot!.id)).toEqual(first.snapshot!)
})
test('returned candidates cannot modify the authoritative provider result', async () => {
  const candidate = (await service.search(actor, { sessionId: 'session-a', query: 'public' })).items[0]!
  candidate.abstract = 'Forged content'; candidate.identifiers.doi = '10.9999/forged'
  const selected = service.select(actor, { sessionId: 'session-a', candidateId: candidate.id, expectedRevision: 1 })
  if (selected.status !== 'selected') throw Error('unexpected identity conflict')
  expect(selected.source.abstract).toBe(article.abstract); expect(selected.source.identifiers.doi).toBe(article.identifiers.doi)
})
test('cache and identity reuse stay within scope and policy; colliding identities return a conflict', async () => {
  repo.put(actor, 'source', { id: 'private-copy', scope, policy: 'restricted', provider: 'pdf-import', title: 'Private annotation', abstract: 'Private abstract', identifiers: { pmid: '123' }, license: { status: 'unknown' }, createdAt: 1 })
  const first = service.select(actor, { sessionId: 'session-a', candidateId: (await service.search(actor, { sessionId: 'session-a', query: 'public' })).items[0]!.id, expectedRevision: 1 })
  if (first.status !== 'selected') throw Error('unexpected identity conflict')
  expect(first.source.abstract).toBe(article.abstract); expect(first.source.id).not.toBe('private-copy')
  repo.createProject(actor, 'project', 'Project')
  repo.put(actor, 'session', { id: 'project-session', ownerId: 'alice', scope: { kind: 'project', projectId: 'project' }, policy: 'public', name: 'Project', revision: 1, createdAt: 1 })
  await service.search(actor, { sessionId: 'project-session', query: 'public' }); expect(calls).toBe(2)
  repo.put(actor, 'source', { id: 'other-family', scope, policy: 'public', provider: 'pdf-import', identifiers: { pmcid: 'PMC987' }, license: { status: 'unknown' }, createdAt: 1 })
  records = [{ ...article, identifiers: { ...article.identifiers, pmcid: 'PMC987' } }]
  const conflict = service.select(actor, { sessionId: 'session-a', candidateId: (await service.search(actor, { sessionId: 'session-a', query: 'collision' })).items[0]!.id, expectedRevision: 2 })
  expect(conflict.status).toBe('identity-conflict'); expect(repo.get(actor, 'session', 'session-a')).toMatchObject({ revision: 2 })
})
test('current authority and session policy are rechecked after the external await', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const delayed = new LiteratureService(repo, { search: async () => { await pending; return { items: [article] } }, record: async () => article, openText: async () => new Uint8Array() })
  const result = delayed.search(actor, { sessionId: 'session-a', query: 'public' })
  repo.put(actor, 'session', { ...repo.get(actor, 'session', 'session-a'), policy: 'restricted', revision: 2 }, 1)
  release(); await expect(result).rejects.toThrow('This context cannot be sent to a cloud model.')
})
test('PDF registration defaults private, records explicit public declaration, and internal copies preserve restriction', () => {
  const privatePdf = service.registerPdf(actor, { sessionId: 'session-a', expectedRevision: 1, bytes: new TextEncoder().encode('%PDF-1.7 synthetic private') })
  expect(privatePdf.source.policy).toBe('restricted'); expect(privatePdf.source.declaration).toBeUndefined()
  repo.put(actor, 'session', { id: 'session-b', ownerId: 'alice', scope, policy: 'public', name: 'Public', revision: 1, createdAt: 1 })
  const publicPdf = service.registerPdf(actor, { sessionId: 'session-b', expectedRevision: 1, bytes: new TextEncoder().encode('%PDF-1.7 synthetic public'), declaredPublic: true })
  expect(publicPdf.source.policy).toBe('public'); expect(publicPdf.source.declaration?.kind).toBe('explicit-public-pdf')
  const copy = service.copySource(actor, { sessionId: 'session-b', expectedRevision: 2, sourceId: privatePdf.source.id })
  expect(copy.source.policy).toBe('restricted'); expect(copy.session.policy).toBe('restricted')
})
test('search candidates are ephemeral; only selected source and immutable abstract enter the session', async () => {
  const page = await service.search(actor, { sessionId: 'session-a', query: 'public' })
  expect(() => repo.get(actor, 'source', page.items[0].id)).toThrow()
  const selected = service.select(actor, { sessionId: 'session-a', candidateId: page.items[0].id, expectedRevision: 1 })
  if (selected.status !== 'selected' || !selected.snapshot) throw Error('missing selected snapshot')
  expect(selected.status).toBe('selected'); expect(selected.source.declaration).toEqual({ actorId: 'alice', declaredAt: now, kind: 'public-provider' })
  expect(selected.session.selectedSourceIds).toEqual([selected.source.id])
  expect(selected.snapshot.coverage.level).toBe('abstract'); expect(selected.snapshot.blocks[0].text).toBe(article.abstract!)
  expect(repo.get(actor, 'snapshot', selected.snapshot.id)).toEqual(selected.snapshot)
})
test('cache expires at 15 minutes and sticky private sessions never call the provider', async () => {
  await service.search(actor, { sessionId: 'session-a', query: 'public' }); await service.search(actor, { sessionId: 'session-a', query: 'public' }); expect(calls).toBe(1)
  now += 900000; await service.search(actor, { sessionId: 'session-a', query: 'public' }); expect(calls).toBe(2)
  repo.put(actor, 'session', { ...repo.get(actor, 'session', 'session-a'), policy: 'restricted', revision: 2 }, 1)
  await expect(service.search(actor, { sessionId: 'session-a', query: 'private experiment' })).rejects.toThrow()
  expect(calls).toBe(2)
})
test('stable mixed identifiers reuse a family, metadata revisions retain old citations, title alone never merges', async () => {
  const first = service.select(actor, { sessionId: 'session-a', candidateId: (await service.search(actor, { sessionId: 'session-a', query: 'first' })).items[0].id, expectedRevision: 1 })
  records = [{ ...article, providerId: 'PMC:PMC123', identifiers: { doi: 'https://doi.org/10.1234/PUBLIC', pmcid: 'PMC123' }, title: 'Corrected title' }]
  const second = service.select(actor, { sessionId: 'session-a', candidateId: (await service.search(actor, { sessionId: 'session-a', query: 'second' })).items[0].id, expectedRevision: 2 })
  if (first.status !== 'selected' || second.status !== 'selected') throw Error('unexpected identity conflict')
  expect(second.source.sourceIdentityId).toBe(first.source.sourceIdentityId); expect(second.source.id).not.toBe(first.source.id)
  expect(second.source.metadataConflictFields).toContain('title'); expect(repo.get(actor, 'source', first.source.id)).toEqual(first.source)
  expect(second.session.selectedSourceIds).toEqual([second.source.id])
  records = [{ ...article, providerId: 'AGR:unrelated', identifiers: {}, title: first.source.title }]
  const third = service.select(actor, { sessionId: 'session-a', candidateId: (await service.search(actor, { sessionId: 'session-a', query: 'third' })).items[0].id, expectedRevision: 3 })
  if (third.status !== 'selected') throw Error('unexpected identity conflict')
  expect(third.source.sourceIdentityId).not.toBe(first.source.sourceIdentityId)
})
test('stale selection writes no source, and candidates cannot cross sessions or auth bindings', async () => {
  const candidate = (await service.search(actor, { sessionId: 'session-a', query: 'first' })).items[0]
  const before = repo.counts().outbox
  expect(() => service.select(actor, { sessionId: 'session-a', candidateId: candidate.id, expectedRevision: 99 })).toThrow()
  expect(repo.counts().outbox).toBe(before)
  expect(() => service.select({ ...actor, authSessionId: 'other-login' }, { sessionId: 'session-a', candidateId: candidate.id, expectedRevision: 1 })).toThrow()
})
