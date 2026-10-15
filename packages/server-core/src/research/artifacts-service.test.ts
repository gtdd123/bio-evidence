import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { ArtifactsService } from './artifacts-service'
import { ResearchAuthorizationGate } from './authorization-gate'
import { RESEARCH_CHANNELS as R } from '@bio-evidence/research-core'
const actor = { userId: 'alice', authSessionId: 'auth-alice', active: true, administrator: false }, scope = { kind: 'personal', ownerId: 'alice' } as const
const citation = { snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18, quote: 'Synthetic evidence' }
let repo: SqliteResearchRepository, service: ArtifactsService
beforeEach(() => {
  repo = new SqliteResearchRepository(); repo.seedUser({ id: 'alice', username: 'alice', passwordHash: 'synthetic', active: true, administrator: false, revision: 1 })
  repo.put(actor, 'source', { id: 'source', scope, policy: 'public', provider: 'pdf-import', identifiers: {}, license: { status: 'unknown' }, createdAt: 1 })
  repo.put(actor, 'snapshot', { id: 'snapshot', sourceId: 'source', scope, policy: 'public', license: { status: 'unknown' }, format: 'pdf', acquiredBy: 'declared-public-pdf', retrievedAt: 1, contentHash: 'a'.repeat(64),
    coverage: { level: 'full', totalUnits: 1, units: [{ unit: 1, status: 'read' }] }, blocks: [{ id: 'block', unit: 1, text: 'Synthetic evidence about cells.', locator: { kind: 'pdf-page', page: 1 } }] })
  repo.put(actor, 'session', { id: 'session', ownerId: 'alice', scope, name: 'Research', policy: 'public', revision: 1, createdAt: 1 })
  service = new ArtifactsService(repo)
})
afterEach(() => repo.close())
test('exact citations are structurally valid while scientific claims remain unreviewed', () => {
  const evidence = service.createEvidence(actor, { sessionId: 'session', claim: 'A deliberately unsupported scientific claim.', citations: [citation] })
  expect(evidence.structuralStatus).toBe('structure-valid'); expect(evidence.reviewStatus).toBe('unreviewed'); expect(evidence.policy).toBe('restricted')
  const pending = service.createEvidence(actor, { sessionId: 'session', claim: 'Claim', citations: [{ ...citation, quote: 'Fabricated excerpt' }] })
  expect(pending.structuralStatus).toBe('pending'); expect(pending.reviewStatus).toBe('unreviewed')
})
test('metadata conflicts are pending and same-revision human review is immutable', () => {
  const old = repo.get(actor, 'source', 'source')
  repo.put(actor, 'source', { ...old, id: 'conflict-source', sourceIdentityId: 'source', revision: 2, predecessorId: 'source', metadataConflictFields: ['title'], createdAt: Date.now() }, 1)
  const pending = service.createEvidence(actor, { sessionId: 'session', claim: 'Claim', citations: [citation] })
  expect(pending.structuralStatus).toBe('pending')
  repo.reviewRevision(actor, 'evidence', pending.id, 1, 'needs-changes', Date.now())
  expect(() => repo.reviewRevision(actor, 'evidence', pending.id, 1, 'needs-changes', Date.now())).toThrow('The revision has changed.')
})
test('metadata acknowledgement binds the exact source revision without replacing snapshot text', () => {
  const old = repo.get(actor, 'source', 'source')
  repo.put(actor, 'source', { ...old, id: 'conflict-source', sourceIdentityId: 'source', revision: 2, predecessorId: 'source', metadataConflictFields: ['title'], createdAt: Date.now() }, 1)
  const reviewed = service.confirmSourceMetadata(actor, 'conflict-source', 2)
  expect(reviewed.metadataReview!.sourceId).toBe('conflict-source'); expect(reviewed.metadataReview!.reviewerId).toBe('alice')
  const evidence = service.createEvidence(actor, { sessionId: 'session', claim: 'Known snapshot claim', citations: [citation], factSummary: 'Observed saved excerpt', limitations: 'Synthetic only', missingInformation: ['Sample size unavailable'] })
  expect(evidence.structuralStatus).toBe('structure-valid'); expect(evidence.factSummary).toBe('Observed saved excerpt')
  expect(evidence.missingInformation).toEqual(['Sample size unavailable'])
  expect(repo.get(actor, 'snapshot', 'snapshot')).toMatchObject({ contentHash: 'a'.repeat(64) })
})

test('source payload cannot grant itself a human metadata acknowledgement', () => {
  const source = repo.get(actor, 'source', 'source')
  expect(() => repo.put(actor, 'source', { ...source, id: 'forged-source', metadataConflictFields: ['title'], metadataReview: { sourceId: 'forged-source', sourceRevision: 1, reviewerId: 'not-a-real-reviewer', reviewedAt: 1 } })).toThrow()
  expect(() => repo.get(actor, 'source', 'forged-source')).toThrow()
})

test('artifact audits record failed saves and successful or denied exports without body content', () => {
  const first = service.createEvidence(actor, { sessionId: 'session', claim: 'PRIVATE-AUDIT-BODY', citations: [citation] })
  service.exportEvidence(actor, first.id)
  expect(() => service.saveEvidence(actor, { evidenceId: first.evidenceId, expectedRevision: 99, claim: 'SECRET-EDIT', citations: [citation] })).toThrow()
  repo.seedUser({ id: 'bob', username: 'bob', passwordHash: 'synthetic', active: true, administrator: false, revision: 1 })
  expect(() => service.exportEvidence({ ...actor, userId: 'bob' }, first.id)).toThrow()
  const audit = repo.readAudit(actor, scope)
  expect(audit).toContainEqual(expect.objectContaining({ action: 'artifact-evidence-export-operation', outcome: 'success', resourceId: first.id }))
  expect(audit).toContainEqual(expect.objectContaining({ action: 'artifact-evidence-export-operation', outcome: 'denied', resourceId: first.id }))
  expect(audit).toContainEqual(expect.objectContaining({ action: 'artifact-evidence-save-operation', outcome: 'failed', resourceId: first.evidenceId }))
  expect(JSON.stringify(audit)).not.toContain('PRIVATE-AUDIT-BODY'); expect(JSON.stringify(audit)).not.toContain('SECRET-EDIT')
})
test('editing a reviewed revision preserves history, resets review, and rejects stale CAS', () => {
  const first = service.createEvidence(actor, { sessionId: 'session', claim: 'Old claim', citations: [citation] })
  repo.reviewRevision(actor, 'evidence', first.id, 1, 'confirmed', Date.now())
  const next = service.saveEvidence(actor, { evidenceId: first.evidenceId, expectedRevision: 1, claim: 'Changed claim', citations: [citation] })
  expect(next.id).not.toBe(first.id); expect(next.revision).toBe(2); expect(next.reviewStatus).toBe('unreviewed')
  expect(repo.get(actor, 'evidence', first.id)).toMatchObject({ claim: 'Old claim', reviewStatus: 'confirmed' })
  expect(() => service.saveEvidence(actor, { evidenceId: first.evidenceId, expectedRevision: 1, claim: 'Stale claim', citations: [citation] })).toThrow()
})
test('reports map claims to exact evidence revisions and edited unmapped text needs a new review', () => {
  const evidence = service.createEvidence(actor, { sessionId: 'session', claim: 'Evidence claim', citations: [citation] })
  const first = service.createReport(actor, { sessionId: 'session', title: 'Report', researchQuestion: 'Synthetic question', materialScope: 'One synthetic PDF', limitations: 'Synthetic materials', missingInformation: ['Real experiments unavailable'], claims: [{ id: 'claim', text: 'Report claim', evidenceRevisionIds: [evidence.id], isInference: true }] })
  expect(first.structuralStatus).toBe('structure-valid'); expect(first.reviewStatus).toBe('unreviewed')
  expect(first.markdown).toContain('（推断）'); expect(first.missingInformation).toEqual(['Real experiments unavailable'])
  expect(service.exportReport(actor, first.id).content).toContain('Synthetic question')
  repo.reviewRevision(actor, 'report', first.id, 1, 'confirmed', Date.now())
  const next = service.saveReport(actor, { reportId: first.reportId, expectedRevision: 1, title: 'Report edited', markdown: 'Free edit without mapped claims', evidenceRevisionIds: [evidence.id], claims: [] })
  expect(next.structuralStatus).toBe('pending'); expect(next.reviewStatus).toBe('unreviewed')
  expect(repo.get(actor, 'report', first.id)).toMatchObject({ reviewStatus: 'confirmed' })
})
test('large exports and dependency scans stop at the byte budget before later references are read', () => {
  const text = 'x'.repeat(200000)
  repo.put(actor, 'snapshot', { id: 'large-snapshot', sourceId: 'source', scope, policy: 'public', license: { status: 'unknown' }, format: 'pdf', acquiredBy: 'declared-public-pdf', retrievedAt: 1, contentHash: 'b'.repeat(64),
    coverage: { level: 'full', totalUnits: 1, units: [{ unit: 1, status: 'read' }] }, blocks: [{ id: 'large-block', unit: 1, text, locator: { kind: 'pdf-page', page: 1 } }] })
  repo.put(actor, 'evidence', { id: 'large-evidence', evidenceId: 'large-family', sessionId: 'session', scope, policy: 'restricted', revision: 1, claim: 'Large evidence',
    citations: Array.from({ length: 50 }, () => ({ snapshotId: 'large-snapshot', blockId: 'large-block', start: 0, end: 200000, quote: text })), structuralStatus: 'structure-valid', reviewStatus: 'unreviewed', authorId: 'alice', createdAt: 1 })
  const original = repo.get.bind(repo); let missingReads = 0, snapshotReads = 0
  repo.get = (current, kind, id) => { if (id === 'must-not-read') missingReads++; if (id === 'large-snapshot') snapshotReads++; return original(current, kind, id) }
  expect(() => service.createReport(actor, { sessionId: 'session', title: 'Too large', claims: [{ id: 'claim', text: 'Claim', evidenceRevisionIds: ['large-evidence', 'must-not-read'] }] })).toThrow('exceeds the configured budget')
  expect(missingReads).toBe(0)
  expect(() => service.exportEvidence(actor, 'large-evidence')).toThrow('exceeds the configured budget')
  expect(repo.readAudit(actor, scope)).toContainEqual(expect.objectContaining({ action: 'artifact-evidence-export-operation', outcome: 'failed', resourceId: 'large-evidence' }))
  expect(snapshotReads).toBeLessThan(100)
  const page = service.list(actor, 'session', 200)
  expect(page.items).toHaveLength(1)
  expect(page.items[0]!.value.title).toBe('Large evidence')
  expect(page.items[0]!.value).not.toHaveProperty('citations')
  expect(JSON.stringify(page).length).toBeLessThan(2000)
  expect(snapshotReads).toBeLessThan(100)
})

test('save response replay rejects fabricated content, wrong revisions and superseded review state', () => {
  const gate = new ResearchAuthorizationGate(repo, undefined, undefined, undefined, undefined, service)
  gate.enable(R.SAVE_EVIDENCE); gate.enable(R.SAVE_REPORT)
  const first = service.createEvidence(actor, { sessionId: 'session', claim: 'Original', citations: [citation] })
  const input = { evidenceId: first.evidenceId, expectedRevision: 1, claim: 'Saved', citations: [citation] }
  const next = service.saveEvidence(actor, input)
  expect(() => gate.authorizeResponse(actor, R.SAVE_EVIDENCE, [input], next)).not.toThrow()
  expect(() => gate.authorizeResponse(actor, R.SAVE_EVIDENCE, [input], { ...next, claim: 'Fabricated' })).toThrow()
  expect(() => gate.authorizeResponse(actor, R.SAVE_EVIDENCE, [{ ...input, expectedRevision: 2 }], next)).toThrow()
  repo.reviewRevision(actor, 'evidence', next.id, 2, 'confirmed', Date.now())
  expect(() => gate.authorizeResponse(actor, R.SAVE_EVIDENCE, [input], next)).toThrow()
  const report = service.createReport(actor, { sessionId: 'session', title: 'Report', claims: [{ id: 'claim', text: 'Claim', evidenceRevisionIds: [next.id] }] })
  const edit = { reportId: report.reportId, expectedRevision: 1, title: 'Edited', markdown: 'Edited text', evidenceRevisionIds: [next.id], claims: [] }
  const saved = service.saveReport(actor, edit)
  expect(() => gate.authorizeResponse(actor, R.SAVE_REPORT, [edit], saved)).not.toThrow()
  expect(() => gate.authorizeResponse(actor, R.SAVE_REPORT, [edit], { ...saved, markdown: 'Fabricated' })).toThrow()
  repo.reviewRevision(actor, 'report', saved.id, 2, 'needs-changes', Date.now())
  expect(() => gate.authorizeResponse(actor, R.SAVE_REPORT, [edit], saved)).toThrow()
})
test('source refresh exposes stale provenance while old snapshot references remain exact', () => {
  const evidence = service.createEvidence(actor, { sessionId: 'session', claim: 'Claim', citations: [citation] })
  const old = repo.get(actor, 'source', 'source')
  repo.put(actor, 'source', { ...old, id: 'new-source', sourceIdentityId: 'source', revision: 2, predecessorId: 'source', title: 'Updated source', createdAt: Date.now() }, 1)
  expect(service.evidenceView(actor, evidence.id).changedSources).toEqual([{ snapshotId: 'snapshot', sourceId: 'source', currentSourceId: 'new-source' }])
  expect(repo.get(actor, 'snapshot', 'snapshot')).toMatchObject({ blocks: [{ text: 'Synthetic evidence about cells.' }] })
})
test('CSV formulas and Markdown HTML/link syntax are neutralized on export', () => {
  const evidence = service.createEvidence(actor, { sessionId: 'session', claim: '=HYPERLINK("https://invalid.example")', citations: [citation] })
  expect(service.exportEvidence(actor, evidence.id).content).toContain("'=HYPERLINK")
  expect(service.exportEvidence(actor, evidence.id).content).toContain('coverage_level')
  const report = service.createReport(actor, { sessionId: 'session', title: '<script>Title</script>', claims: [{ id: 'claim', text: '<img src=x onerror=alert(1)> [click](javascript:alert(1))', evidenceRevisionIds: [evidence.id] }] })
  const exported = service.exportReport(actor, report.id)
  expect(exported.content).not.toContain('<img'); expect(exported.content).not.toContain('<script>'); expect(exported.content).toContain('&lt;img')
  expect(exported.content).toContain('\\[click\\]'); expect(exported.policy).toBe('restricted')
  expect(exported.content).toContain('取得方式：declared-public-pdf'); expect(exported.content).toContain('来源修订：`source`')
  expect(exported.content).toContain('指纹：`' + 'a'.repeat(64)); expect(exported.content).toContain('覆盖：full')
})
test('explicit public edits retain actor/time while source restrictions and session taint cannot be lowered', () => {
  const evidence = service.createEvidence(actor, { sessionId: 'session', claim: 'Public claim', citations: [citation], declaredPublic: true })
  expect(evidence.policy).toBe('public'); expect(evidence.declaration?.actorId).toBe('alice')
  const old = repo.get(actor, 'source', 'source')
  repo.put(actor, 'source', { ...old, id: 'restricted-source', sourceIdentityId: 'source', revision: 2, predecessorId: 'source', policy: 'restricted', createdAt: Date.now() }, 1)
  expect(service.evidenceView(actor, evidence.id).effectivePolicy).toBe('restricted'); expect(service.exportEvidence(actor, evidence.id).policy).toBe('restricted')
  expect(() => service.createEvidence(actor, { sessionId: 'session', claim: 'Unsafe public claim', citations: [citation], declaredPublic: true })).toThrow()
  const privateEvidence = service.createEvidence(actor, { sessionId: 'session', claim: 'Private claim', citations: [citation] })
  expect(repo.get(actor, 'session', 'session')).toMatchObject({ policy: 'restricted' })
  expect(() => service.saveEvidence(actor, { evidenceId: privateEvidence.evidenceId, expectedRevision: 1, claim: 'Try public', citations: [citation], declaredPublic: true })).toThrow()
})
