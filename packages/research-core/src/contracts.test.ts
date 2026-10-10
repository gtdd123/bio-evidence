import { describe, expect, test } from 'bun:test';
import {
  parseCreateSession, parseResearchRequest, validateSnapshot, assertScopeAccess,
  mergePolicies, mergeSessionPolicy, assertPublicContext, validateCitation, assertRevision, transitionRun, reviseEvidence,
  type ReadingSnapshot,
  assertSnapshotSource, SourceSchema,
  EvidenceRevisionSchema, ReportRevisionSchema, RunSchema, SessionSchema,
  assertSessionControl,
  LicenseSchema, renderReportMarkdown,
} from './index.ts';

const personal = { kind: 'personal', ownerId: 'alice' } as const;
const actor = { userId: 'alice', authSessionId: 'auth-a', administrator: false, active: true };
const create = { scope: personal, name: '公开文献调研', sourceIds: ['paper-a'] };
const snapshot: ReadingSnapshot = {
  id: 'snapshot-a', sourceId: 'paper-a', scope: personal, policy: 'public', license: { status: 'unknown' },
  format: 'pdf', acquiredBy: 'declared-public-pdf', retrievedAt: 1,
  contentHash: 'a'.repeat(64),
  coverage: { level: 'full', totalUnits: 2, units: [{ unit: 1, status: 'read' }, { unit: 2, status: 'read' }] },
  blocks: [
    { id: 'block-a', unit: 1, text: 'Cells moved under condition A.', locator: { kind: 'pdf-page', page: 1 } },
    { id: 'block-b', unit: 2, text: 'Condition B had no measured effect.', locator: { kind: 'pdf-page', page: 2 } },
  ],
};
const citation = { snapshotId: 'snapshot-a', blockId: 'block-a', start: 0, end: 11, quote: 'Cells moved' };
const run = {
  id: 'run-a', sessionId: 'research-a', scope: personal, actorId: 'alice',
  connectionId: 'gpt-official', state: 'running', generation: 1, revision: 1,
  lease: { runId: 'run-a', workerId: 'worker-a', generation: 1, expiresAt: 1000 },
  createdAt: 1, startedAt: 2, sourceIds: ['paper-a'], artifactIds: [],
};

describe('research request boundary', () => {
  test('accepts the versioned minimal create DTO', () => expect(parseCreateSession(create)).toEqual(create));
  test('rejects client actor and policy injection', () => {
    for (const field of [{ actor }, { policy: 'public' }, { administrator: true }]) {
      expect(() => parseCreateSession({ ...create, ...field })).toThrow();
    }
  });
  test('rejects traversal identifiers and duplicate selection', () => {
    expect(() => parseCreateSession({ ...create, sourceIds: ['../private'] })).toThrow();
    expect(() => parseCreateSession({ ...create, sourceIds: ['paper-a', 'paper-a'] })).toThrow();
  });
  test('rejects unknown channels, arbitrary URLs and oversized pagination', () => {
    expect(() => parseResearchRequest('research:v1:unknown', {})).toThrow();
    expect(() => parseResearchRequest('research:v1:search', { sessionId: 'research-a', query: 'cell', pageSize: 201 })).toThrow();
    expect(() => parseResearchRequest('research:v1:search', { sessionId: 'research-a', query: 'cell', url: 'file:///private' })).toThrow();
  });
});

describe('scope and data policy', () => {
  test('allows personal owner and active project reader', () => {
    expect(() => assertScopeAccess(actor, personal, null, 'write')).not.toThrow();
    expect(() => assertScopeAccess(actor, { kind: 'project', projectId: 'project-a' },
      { projectId: 'project-a', userId: 'alice', role: 'viewer', active: true }, 'read')).not.toThrow();
  });
  test('administrator does not inherit other personal content', () => {
    expect(() => assertScopeAccess({ ...actor, administrator: true }, { kind: 'personal', ownerId: 'bob' }, null, 'read')).toThrow();
  });
  test('rejects revoked, mismatched and read-only project membership', () => {
    for (const member of [
      { projectId: 'project-a', userId: 'alice', role: 'viewer', active: false },
      { projectId: 'project-b', userId: 'alice', role: 'editor', active: true },
      { projectId: 'project-a', userId: 'bob', role: 'editor', active: true },
      { projectId: 'project-a', userId: 'alice', role: 'viewer', active: true },
    ]) expect(() => assertScopeAccess(actor, { kind: 'project', projectId: 'project-a' }, member, 'write')).toThrow();
    expect(() => assertScopeAccess({ ...actor, active: false }, personal, null, 'read')).toThrow();
  });
  test('restricted and unknown classifications survive composition', () => {
    expect(mergePolicies(['public', 'restricted'])).toBe('restricted');
    expect(mergePolicies(['public', 'unknown'])).toBe('unknown');
    expect(mergePolicies([])).toBe('unknown');
    expect(() => mergePolicies(['invalid'])).toThrow();
  });
  test('cloud boundary rejects empty, unknown and mixed manifests', () => {
    expect(() => assertPublicContext([{ id: 'paper-a', policy: 'public' }])).not.toThrow();
    for (const resources of [[], [{ id: 'x', policy: 'unknown' }], [{ id: 'x', policy: 'public' }, { id: 'y', policy: 'restricted' }]]) {
      expect(() => assertPublicContext(resources)).toThrow();
    }
  });
  test('clearing selected files cannot downgrade a restricted session', () => {
    expect(mergeSessionPolicy('restricted', [])).toBe('restricted');
    expect(mergeSessionPolicy('restricted', ['public'])).toBe('restricted');
    expect(mergeSessionPolicy('unknown', ['public'])).toBe('unknown');
  });
});

describe('reading snapshots and structural citations', () => {
  test('full JATS cannot count the same paragraph as two read units', () => {
    expect(() => validateSnapshot({ ...snapshot, format: 'jats', acquiredBy: 'europe-pmc-oa',
      blocks: snapshot.blocks.map(block => ({ ...block, locator: { kind: 'jats-paragraph', paragraphId: 'same-paragraph' } })),
    })).toThrow();
  });
  test('snapshot cannot elevate an unknown source or bind to another scope', () => {
    const source = { id: 'paper-a', scope: personal, policy: 'public', license: { status: 'unknown' }, provider: 'pdf-import', identifiers: {}, createdAt: 1 };
    expect(() => assertSnapshotSource(snapshot, source)).not.toThrow();
    expect(() => assertSnapshotSource(snapshot, { ...source, policy: 'unknown' })).toThrow();
    expect(() => assertSnapshotSource(snapshot, { ...source, scope: { kind: 'personal', ownerId: 'bob' } })).toThrow();
    expect(() => assertSnapshotSource(snapshot, { ...source, id: 'other' })).toThrow();
    const parsed = SourceSchema.parse(source);
    expect(parsed).not.toHaveProperty('title');
    expect(parsed).not.toHaveProperty('authors');
    expect(parsed.identifiers).toEqual({});
  });
  test('accepts a fully accounted two-page snapshot', () => expect(validateSnapshot(snapshot)).toEqual(snapshot));
  test('cannot call an unread or omitted page full text', () => {
    expect(() => validateSnapshot({ ...snapshot, coverage: { ...snapshot.coverage, units: [{ unit: 1, status: 'read' }, { unit: 2, status: 'no-text' }] } })).toThrow();
    expect(() => validateSnapshot({ ...snapshot, coverage: { ...snapshot.coverage, units: [{ unit: 1, status: 'read' }] } })).toThrow();
    expect(() => validateSnapshot({ ...snapshot, blocks: [snapshot.blocks[0]] })).toThrow();
  });
  test('rejects duplicate block IDs and mismatched page locators', () => {
    expect(() => validateSnapshot({ ...snapshot, blocks: [snapshot.blocks[0], snapshot.blocks[0]] })).toThrow();
    expect(() => validateSnapshot({ ...snapshot, blocks: [{ ...snapshot.blocks[0], locator: { kind: 'pdf-page', page: 2 } }, snapshot.blocks[1]] })).toThrow();
  });
  test('exact excerpt is structural validity, never scientific approval', () => {
    const result = validateCitation(snapshot, citation);
    expect(result.status).toBe('structure-valid');
    expect(result).not.toHaveProperty('reviewed');
    expect(result).not.toHaveProperty('scientificallySupported');
  });
  test('rejects missing snapshot/block, wrong offsets and invented excerpts', () => {
    for (const bad of [{ ...citation, snapshotId: 'other' }, { ...citation, blockId: 'missing' },
      { ...citation, end: 10000 }, { ...citation, quote: 'Cells died' }]) {
      expect(validateCitation(snapshot, bad).status).toBe('pending');
    }
  });
});

describe('revision and run contracts', () => {
  const evidence = {
    id: 'evidence-rev-a', evidenceId: 'evidence-a', scope: personal, revision: 1,
    claim: 'Initial claim', citations: [citation], structuralStatus: 'structure-valid',
    reviewStatus: 'confirmed', authorId: 'alice', createdAt: 1,
    review: { reviewerId: 'alice', reviewedAt: 2, revisionId: 'evidence-rev-a', revisionNumber: 1 },
  };
  test('pending evidence cannot have a confirmed review', () => {
    expect(() => EvidenceRevisionSchema.parse({ ...evidence, structuralStatus: 'pending' })).toThrow();
    expect(() => EvidenceRevisionSchema.parse({ ...evidence, review: undefined })).toThrow();
  });
  test('an empty ungrounded report stays a draft', () => {
    expect(() => ReportRevisionSchema.parse({
      id: 'report-rev-a', reportId: 'report-a', scope: personal, revision: 1, title: 'Report',
      markdown: 'Unsupported claim', evidenceRevisionIds: [], structuralStatus: 'structure-valid',
      reviewStatus: 'confirmed', authorId: 'alice', createdAt: 1,
    })).toThrow();
  });
  test('report titles cannot hide unreferenced paragraphs in the heading', () => {
    const report = { id: 'report-rev-a', reportId: 'report-a', scope: personal, revision: 1,
      title: 'Report\n\nUNMAPPED conclusion', evidenceRevisionIds: ['evidence-rev-a'],
      claims: [{ id: 'claim-a', text: 'Mapped observation', evidenceRevisionIds: ['evidence-rev-a'] }],
      structuralStatus: 'structure-valid', reviewStatus: 'confirmed', authorId: 'alice', createdAt: 1,
      review: { reviewerId: 'alice', reviewedAt: 2, revisionId: 'report-rev-a', revisionNumber: 1 } };
    const markdown = renderReportMarkdown(report);
    expect(() => ReportRevisionSchema.parse({ ...report, markdown })).toThrow();
    expect(() => parseResearchRequest('research:v1:saveReport', { reportId: report.reportId, expectedRevision: 1,
      title: report.title, markdown, evidenceRevisionIds: report.evidenceRevisionIds, claims: report.claims })).toThrow();
    expect(() => ReportRevisionSchema.parse({ ...report, title: '   ', markdown })).toThrow();
  });
  test('claim and read block text cannot consist of whitespace alone', () => {
    expect(() => EvidenceRevisionSchema.parse({ ...evidence, claim: ' \r\n ' })).toThrow();
    expect(() => validateSnapshot({ ...snapshot, blocks: [{ ...snapshot.blocks[0], text: ' \n ' }, snapshot.blocks[1]] })).toThrow();
  });
  test('drafts remain editable and review metadata must bind to this revision', () => {
    const draft = { id: 'report-rev-a', reportId: 'report-a', scope: personal, revision: 1,
      title: 'Draft', markdown: 'Unmapped draft claim', evidenceRevisionIds: [],
      structuralStatus: 'pending', reviewStatus: 'unreviewed', authorId: 'alice', createdAt: 1 };
    expect(ReportRevisionSchema.safeParse(draft).success).toBe(true);
    expect(() => EvidenceRevisionSchema.parse({ ...evidence, review: { ...evidence.review, revisionId: 'old-revision' } })).toThrow();
    expect(() => EvidenceRevisionSchema.parse({ ...evidence, review: { ...evidence.review, revisionNumber: 2 } })).toThrow();
    const report = { ...draft, structuralStatus: 'structure-valid', reviewStatus: 'confirmed',
      evidenceRevisionIds: ['evidence-rev-a'], claims: [{ id: 'claim-a', text: 'Mapped claim', evidenceRevisionIds: ['evidence-rev-a'] }],
      review: { reviewerId: 'alice', reviewedAt: 2, revisionId: 'report-rev-a', revisionNumber: 1 } };
    const grounded = { ...report, markdown: renderReportMarkdown(report) };
    expect(ReportRevisionSchema.safeParse(grounded).success).toBe(true);
    expect(() => ReportRevisionSchema.parse({ ...grounded, markdown: `${grounded.markdown}\n\nUnmapped claim` })).toThrow();
    expect(() => ReportRevisionSchema.parse({ ...report, claims: [{ ...report.claims[0], evidenceRevisionIds: ['missing'] }] })).toThrow();
  });
  test('lease generation and expiry are bound without a client token', () => {
    expect(() => RunSchema.parse({ ...run, lease: { ...run.lease, generation: 2 } })).toThrow();
    expect(() => RunSchema.parse({ ...run, lease: { ...run.lease, token: 'synthetic' } })).toThrow();
    const done = transitionRun(run, 'completed', 1, 3);
    expect(done.state).toBe('completed');
    expect(done).not.toHaveProperty('lease');
  });
  test('license unknown is retained independently of privacy classification', () => {
    expect(validateSnapshot(snapshot).license).toEqual({ status: 'unknown' });
    expect(LicenseSchema.safeParse({ status: 'known', identifier: 'CC-BY-4.0', redistribution: 'allowed' }).success).toBe(true);
    expect(() => assertPublicContext([{ id: 'experiment', policy: 'restricted' }])).toThrow();
    expect(LicenseSchema.safeParse({ status: 'known', identifier: 'label', redistribution: 'allowed', url: 'file:///private' }).success).toBe(false);
  });
  test('active runs require a lease and cannot complete after expiry', () => {
    const { lease: _lease, ...withoutLease } = run;
    expect(() => RunSchema.parse(withoutLease)).toThrow();
    expect(() => transitionRun(run, 'completed', 1, 1001)).toThrow();
  });
  test('research sessions need an explicit owner inside a project scope', () => {
    expect(() => SessionSchema.parse({ id: 'research-a', scope: { kind: 'project', projectId: 'project-a' },
      name: 'Research', policy: 'public', revision: 1, createdAt: 1 })).toThrow();
  });
  test('new evidence revision invalidates checks and preserves the old one', () => {
    const next = reviseEvidence(evidence, { claim: 'Changed claim', citations: [citation] }, 1, 'evidence-rev-b', 'alice', 2);
    expect(next.revision).toBe(2);
    expect(next.structuralStatus).toBe('pending');
    expect(next.reviewStatus).toBe('unreviewed');
    expect(evidence.reviewStatus).toBe('confirmed');
    expect(evidence.claim).toBe('Initial claim');
    expect(() => reviseEvidence(evidence, { claim: 'Change', citations: [citation], reviewStatus: 'confirmed' }, 1, 'evidence-rev-b', 'alice', 2)).toThrow();
    expect(() => reviseEvidence(evidence, { claim: 'Change', citations: [citation] }, 2, 'evidence-rev-b', 'alice', 2)).toThrow();
  });
  test('revision timestamps and active state metadata cannot contradict history', () => {
    expect(() => reviseEvidence(evidence, { claim: 'Change', citations: [citation] }, 1, 'evidence-rev-b', 'alice', 0)).toThrow();
    expect(() => transitionRun({ ...run, startedAt: undefined }, 'completed', 1, 3)).toThrow();
    expect(() => transitionRun({ ...run, state: 'queued' }, 'running', 1, 3)).toThrow();
  });
  test('rejects stale or invalid revision numbers', () => {
    expect(() => assertRevision(3, 3)).not.toThrow();
    expect(() => assertRevision(3, 2)).toThrow();
    expect(() => assertRevision(0, 0)).toThrow();
  });
  test('terminal cancellation cannot be completed by a late result', () => {
    const cancelled = transitionRun(run, 'cancelled', 1);
    expect(cancelled.generation).toBe(2);
    expect(() => transitionRun(cancelled, 'completed', 2)).toThrow();
    expect(() => transitionRun(run, 'completed', 0)).toThrow();
  });
  test('restart interrupts active runs and cannot resurrect a completed one', () => {
    expect(transitionRun(run, 'interrupted', 1).state).toBe('interrupted');
    const { lease: _lease, ...withoutLease } = run;
    expect(() => transitionRun({ ...withoutLease, state: 'completed', finishedAt: 3 }, 'running', 1)).toThrow();
  });
  test('project visibility does not grant execution ownership', () => {
    const session = { id: 'research-a', ownerId: 'bob', scope: { kind: 'project', projectId: 'project-a' },
      name: 'Research', policy: 'public', revision: 1, createdAt: 1 };
    const member = { projectId: 'project-a', userId: 'alice', role: 'editor', active: true };
    expect(() => assertScopeAccess(actor, session.scope, member, 'write')).not.toThrow();
    expect(() => assertSessionControl(actor, session, member)).toThrow();
    const owned = { ...session, ownerId: 'alice' };
    const readOnly = { ...member, role: 'viewer' };
    expect(() => assertSessionControl(actor, owned, readOnly, 'execute')).toThrow();
    expect(() => assertSessionControl(actor, owned, readOnly, 'cancel')).not.toThrow();
  });
});
