import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SqliteResearchRepository } from './sqlite-repository.ts';
import type { Database } from 'bun:sqlite';
import { RunSchema, reviseEvidence, renderReportMarkdown, type ResearchSource } from '@bio-evidence/research-core';

const alice = { userId: 'alice', authSessionId: 'auth-a', active: true, administrator: false };
const bob = { userId: 'bob', authSessionId: 'auth-b', active: true, administrator: false };
const admin = { userId: 'admin', authSessionId: 'auth-admin', active: true, administrator: true };
const scope = { kind: 'personal', ownerId: 'alice' } as const;
const source: ResearchSource = { id: 'paper-a', scope, policy: 'public', license: { status: 'unknown' },
  provider: 'pdf-import', identifiers: {}, createdAt: 1 };

describe('authoritative research transactions', () => {
  let repo: SqliteResearchRepository;
  beforeEach(() => {
    repo = new SqliteResearchRepository();
    for (const actor of [alice, bob, admin]) repo.seedUser({ id: actor.userId, username: actor.userId,
      passwordHash: 'synthetic-hash', active: true, administrator: actor.administrator, revision: 1 });
  });
  afterEach(() => repo.close());
  test('admin and other users cannot read personal resources', () => {
    repo.put(alice, 'source', source);
    expect(repo.get(alice, 'source', 'paper-a')).toEqual(source);
    expect(() => repo.get(bob, 'source', 'paper-a')).toThrow();
    expect(() => repo.get(admin, 'source', 'paper-a')).toThrow();
  });
  test('unknown bindings fail closed', () => {
    expect(() => repo.get(alice, 'source', 'legacy-unbound')).toThrow();
  });
  test('resource cannot change owner or silently elevate its policy', () => {
    repo.put(alice, 'source', { ...source, policy: 'restricted' });
    expect(() => repo.put(alice, 'source', { ...source, policy: 'public' }, 1)).toThrow();
    expect(() => repo.put(bob, 'source', { ...source, scope: { kind: 'personal', ownerId: 'bob' } }, 1)).toThrow();
  });
  test('member revocation is current and membership CAS rejects stale updates', () => {
    repo.createProject(alice, 'project-a', 'Project');
    repo.setMember(alice, 'project-a', 'bob', 'viewer', true, 1);
    const shared: ResearchSource = { ...source, id: 'shared-paper', scope: { kind: 'project', projectId: 'project-a' } };
    repo.put(alice, 'source', shared);
    expect(repo.get(bob, 'source', shared.id)).toEqual(shared);
    repo.setMember(alice, 'project-a', 'bob', 'viewer', false, 2);
    expect(() => repo.get(bob, 'source', shared.id)).toThrow();
    expect(() => repo.setMember(alice, 'project-a', 'bob', 'editor', true, 2)).toThrow();
  });
  test('competing writes with the same expected revision have one winner', async () => {
    repo.put(alice, 'source', source);
    const results = await Promise.allSettled(['First', 'Second'].map(title =>
      Promise.resolve().then(() => repo.put(alice, 'source', { ...source, id: `paper-${title.toLowerCase()}`, sourceIdentityId: source.id,
        revision: 2, predecessorId: source.id, title, createdAt: 2 }, 1))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  test('a source revision cannot overwrite the identity of an older record', () => {
    repo.put(alice, 'source', source);
    expect(() => repo.put(alice, 'source', { ...source, title: 'Replacement metadata' }, 1)).toThrow('The revision has changed.');
    expect(repo.get(alice, 'source', source.id)).toEqual(source);
  });
  test('successful writes commit audit and outbox together', () => {
    repo.put(alice, 'source', source);
    expect(repo.counts()).toMatchObject({ audit: 1, outbox: 1 });
  });
  test('journal retains complete messages and deduplicates an operation', () => {
    repo.put(alice, 'session', { id: 'research-a', ownerId: 'alice', scope, policy: 'public',
      name: 'Research', revision: 1, createdAt: 1 });
    const messages = [{ id: 'message-a', role: 'user', content: 'Complete synthetic message', timestamp: 1 }];
    repo.appendProjection(alice, 'research-a', 'operation-a', messages, 1);
    repo.appendProjection(alice, 'research-a', 'operation-a', messages, 1);
    expect(repo.readProjection(alice, 'research-a').map(entry => entry.messages)).toEqual([messages]);
    expect(() => repo.readProjection(bob, 'research-a')).toThrow();
  });
  test('failed outbox insertion rolls the entity and success audit back', () => {
    const db = (repo as unknown as { db: Database }).db;
    db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    expect(() => repo.put(alice, 'source', source)).toThrow();
    expect(repo.counts()).toMatchObject({ audit: 1, outbox: 0 });
    expect(repo.readAudit(alice, { kind: 'personal', ownerId: 'alice' }).map(entry => entry.outcome)).toEqual(['failed']);
    db.exec('DROP TRIGGER reject_outbox');
    expect(() => repo.get(alice, 'source', source.id)).toThrow();
    expect(repo.put(alice, 'source', source)).toEqual(source);
  });
  test('denied reads produce an audit entry without content fields', () => {
    repo.put(alice, 'source', source);
    expect(() => repo.get(bob, 'source', source.id)).toThrow();
    const entries = repo.readAudit(alice, { kind: 'personal', ownerId: 'alice' });
    expect(entries.some(entry => entry.outcome === 'denied')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('synthetic-hash');
    expect(() => repo.readAudit(admin, { kind: 'personal', ownerId: 'alice' })).toThrow();
  });
  test('taint can increase but cannot be removed from a session', () => {
    const session = { id: 'research-a', ownerId: 'alice', scope, policy: 'public', name: 'Research', revision: 1, createdAt: 1 };
    repo.put(alice, 'session', session);
    expect(() => repo.put(alice, 'session', { ...session, policy: 'restricted', revision: 2 }, 1)).not.toThrow();
    expect(() => repo.put(alice, 'session', { ...session, policy: 'public', revision: 3 }, 2)).toThrow();
  });
  test('journal rejects non-message values instead of claiming complete history', () => {
    repo.put(alice, 'session', { id: 'research-a', ownerId: 'alice', scope, policy: 'public', name: 'Research', revision: 1, createdAt: 1 });
    expect(() => repo.appendProjection(alice, 'research-a', 'bad-operation', [null], 1)).toThrow();
  });
  test('generic run writes cannot bypass the lease transition authority', () => {
    repo.put(alice, 'session', { id: 'research-a', ownerId: 'alice', scope, policy: 'public', name: 'Research', revision: 1, createdAt: 1 });
    const run = { id: 'run-a', sessionId: 'research-a', actorId: 'alice', scope, connectionId: 'gpt-official',
      state: 'queued', generation: 1, revision: 1, createdAt: 1, sourceIds: [], artifactIds: [] };
    repo.put(alice, 'run', run);
    expect(() => repo.put(alice, 'run', { ...run, state: 'completed', finishedAt: 2, revision: 2 }, 1)).toThrow();
  });
  test('project editor cannot take over a session or read project audit', () => {
    repo.createProject(alice, 'project-a', 'Project');
    repo.setMember(alice, 'project-a', 'bob', 'editor', true, 1);
    const projectScope = { kind: 'project', projectId: 'project-a' } as const;
    const session = { id: 'research-a', ownerId: 'alice', scope: projectScope, policy: 'public', name: 'Shared', revision: 1, createdAt: 1 };
    repo.put(alice, 'session', session);
    expect(() => repo.put(bob, 'session', { ...session, ownerId: 'bob', revision: 2 }, 1)).toThrow();
    expect(() => repo.readAudit(bob, projectScope)).toThrow();
    expect(repo.readAudit(alice, projectScope).length).toBeGreaterThan(0);
  });
  test('worker identity, expiry, generation and cancellation gate run writes', () => {
    repo.put(alice, 'session', { id: 'research-a', ownerId: 'alice', scope, policy: 'public', name: 'Research', revision: 1, createdAt: 1 });
    const run = { id: 'run-a', sessionId: 'research-a', actorId: 'alice', scope, connectionId: 'gpt-official', state: 'queued', generation: 1,
      revision: 1, createdAt: 1, sourceIds: [], artifactIds: [] };
    repo.put(alice, 'run', run);
    expect(() => repo.put(alice, 'run', { ...run, id: 'other-run' })).toThrow();
    repo.advanceRun(alice, 'run-a', 'running', 1, 'worker-a', 2, 1000);
    const before = repo.counts().outbox;
    expect(() => repo.advanceRun(alice, 'run-a', 'completed', 1, 'wrong-worker', 3)).toThrow();
    expect(() => repo.advanceRun(alice, 'run-a', 'failed', 1, 'worker-a', 1000)).toThrow();
    expect(() => repo.advanceRun(alice, 'run-a', 'completed', 0, 'worker-a', 3)).toThrow();
    expect(() => repo.advanceRun(bob, 'run-a', 'cancelled', 1, null, 3)).toThrow();
    expect(repo.counts().outbox).toBe(before);
    expect(RunSchema.parse(repo.get(alice, 'run', 'run-a')).state).toBe('running');
    expect(repo.advanceRun(alice, 'run-a', 'cancelled', 1, null, 4).generation).toBe(2);
    expect(() => repo.advanceRun(alice, 'run-a', 'completed', 2, 'worker-a', 5)).toThrow();
    expect(RunSchema.parse(repo.get(alice, 'run', 'run-a')).state).toBe('cancelled');
  });
  test('revoked member cannot finish an existing leased run', () => {
    repo.createProject(alice, 'project-a', 'Project');
    repo.setMember(alice, 'project-a', 'bob', 'editor', true, 1);
    const projectScope = { kind: 'project', projectId: 'project-a' };
    repo.put(bob, 'session', { id: 'research-b', ownerId: 'bob', scope: projectScope, policy: 'public', name: 'Research', revision: 1, createdAt: 1 });
    repo.put(bob, 'run', { id: 'run-b', sessionId: 'research-b', actorId: 'bob', scope: projectScope, connectionId: 'gpt-official',
      state: 'queued', generation: 1, revision: 1, createdAt: 1, sourceIds: [], artifactIds: [] });
    repo.advanceRun(bob, 'run-b', 'running', 1, 'worker-b', 2, 1000);
    repo.setMember(alice, 'project-a', 'bob', 'viewer', false, 2);
    const before = repo.counts().outbox;
    expect(() => repo.advanceRun(bob, 'run-b', 'completed', 1, 'worker-b', 3)).toThrow();
    expect(repo.counts().outbox).toBe(before);
  });
  test('valid worker completion commits and an outbox failure rolls it back', () => {
    repo.put(alice, 'session', { id: 'research-a', ownerId: 'alice', scope, policy: 'public', name: 'Research', revision: 1, createdAt: 1 });
    repo.put(alice, 'run', { id: 'run-a', sessionId: 'research-a', actorId: 'alice', scope, connectionId: 'gpt-official',
      state: 'queued', generation: 1, revision: 1, createdAt: 1, sourceIds: [], artifactIds: [] });
    repo.advanceRun(alice, 'run-a', 'running', 1, 'worker-a', 2, 1000);
    const db = (repo as unknown as { db: Database }).db;
    db.exec("CREATE TRIGGER reject_run_outbox BEFORE INSERT ON outbox WHEN NEW.kind='run' BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
    const before = repo.counts();
    expect(() => repo.advanceRun(alice, 'run-a', 'completed', 1, 'worker-a', 3)).toThrow();
    expect(repo.counts()).toEqual({ outbox: before.outbox, audit: before.audit + 1 });
    expect(RunSchema.parse(repo.get(alice, 'run', 'run-a')).state).toBe('running');
    const inspection = db.prepare<{ worker_id: string }, []>('SELECT worker_id FROM run_leases');
    try { expect(inspection.get()?.worker_id).toBe('worker-a'); } finally { inspection.finalize(); }
    db.exec('DROP TRIGGER reject_run_outbox');
    const completed = repo.advanceRun(alice, 'run-a', 'completed', 1, 'worker-a', 4);
    expect(completed).toMatchObject({ state: 'completed', revision: 3, finishedAt: 4 });
    expect(completed).not.toHaveProperty('lease');
    expect(RunSchema.parse(repo.get(alice, 'run', 'run-a')).state).toBe('completed');
  });
  test('immutable revisions retain old reviews and reject pending report dependencies', () => {
    repo.put(alice, 'source', source);
    const snapshot = { id: 'snapshot-a', sourceId: source.id, scope, policy: 'public', license: { status: 'unknown' },
      format: 'pdf', acquiredBy: 'declared-public-pdf', retrievedAt: 1, contentHash: 'a'.repeat(64),
      coverage: { level: 'full', totalUnits: 1, units: [{ unit: 1, status: 'read' }] },
      blocks: [{ id: 'block-a', unit: 1, text: 'Observed result', locator: { kind: 'pdf-page', page: 1 } }] };
    repo.put(alice, 'snapshot', snapshot);
    expect(() => repo.put(alice, 'snapshot', snapshot, 1)).toThrow();
    const citation = { snapshotId: 'snapshot-a', blockId: 'block-a', start: 0, end: 8, quote: 'Observed' };
    const evidence = { id: 'evidence-r1', evidenceId: 'evidence-a', scope, revision: 1, claim: 'Claim', citations: [citation],
      structuralStatus: 'structure-valid', reviewStatus: 'unreviewed', authorId: 'alice', createdAt: 1 };
    repo.put(alice, 'evidence', evidence);
    expect(() => repo.put(alice, 'evidence', { ...evidence, revision: 2 }, 1)).toThrow();
    repo.reviewRevision(alice, 'evidence', evidence.id, 1, 'confirmed', 2);
    const reviewed = repo.get(alice, 'evidence', evidence.id);
    const next = reviseEvidence(reviewed, { claim: 'Changed claim', citations: [citation] }, 1, 'evidence-r2', 'alice', 3);
    repo.put(alice, 'evidence', next, 1);
    expect(repo.get(alice, 'evidence', evidence.id)).toMatchObject({ revision: 1, reviewStatus: 'confirmed' });
    expect(repo.get(alice, 'evidence', next.id)).toMatchObject({ revision: 2, reviewStatus: 'unreviewed' });
    expect(() => repo.reviewRevision(alice, 'evidence', evidence.id, 1, 'needs-changes', 4)).toThrow();
    const claims = [{ id: 'claim-a', text: 'Claim', evidenceRevisionIds: [next.id] }];
    const report = { id: 'report-r1', reportId: 'report-a', scope, revision: 1, title: 'Report', markdown: renderReportMarkdown({ title: 'Report', claims }),
      claims, evidenceRevisionIds: [next.id], structuralStatus: 'structure-valid', reviewStatus: 'unreviewed', authorId: 'alice', createdAt: 4 };
    expect(() => repo.put(alice, 'report', report)).toThrow();
    repo.put(alice, 'report', { ...report, structuralStatus: 'pending' });
    expect(() => repo.put(alice, 'report', { ...report, revision: 2 }, 1)).toThrow();
    expect(() => repo.reviewRevision(alice, 'report', report.id, 1, 'confirmed', 5)).toThrow();
  });
  test('new evidence cannot retain a claimed confirmed review', () => {
    expect(() => repo.put(alice, 'evidence', { id: 'evidence-r1', evidenceId: 'evidence-a', scope, revision: 1, claim: 'Claim',
      citations: [{ snapshotId: 'snapshot-a', blockId: 'block-a', start: 0, end: 1, quote: 'x' }], structuralStatus: 'structure-valid',
      reviewStatus: 'confirmed', review: { reviewerId: 'alice', reviewedAt: 2, revisionId: 'evidence-r1', revisionNumber: 1 },
      authorId: 'alice', createdAt: 1 })).toThrow();
  });
  test('journal preserves attachments, annotations and tool fields', () => {
    repo.put(alice, 'session', { id: 'research-a', ownerId: 'alice', scope, policy: 'restricted', name: 'Local', revision: 1, createdAt: 1 });
    const messages = [{ id: 'message-a', role: 'tool', content: 'Complete output', timestamp: 1, toolInput: { selected: ['a'] },
      toolResult: { ok: true }, attachments: [{ id: 'attachment-a', contentHash: 'a'.repeat(64) }], annotations: [{ text: 'note' }], turnId: 'turn-a' }];
    repo.appendProjection(alice, 'research-a', 'operation-a', messages, 1);
    expect(repo.readProjection(alice, 'research-a')[0]?.messages).toEqual(messages);
    expect(() => repo.appendProjection(alice, 'research-a', 'operation-a', [{ ...messages[0], content: 'Changed' }], 1)).toThrow();
  });
});
