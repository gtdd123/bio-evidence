import { z } from 'zod';
import {
  ActorSchema, ScopeSchema, MembershipSchema, PolicySchema, ResourcePolicySchema,
  SnapshotSchema, CitationSchema, RevisionSchema, GenerationSchema, RunSchema,
  RunStateSchema, TimestampSchema, ResearchError, parseContract,
  EvidenceRevisionSchema, IdSchema, SourceSchema,
  RunLeaseSchema, SessionSchema,
  nonBlankText,
  type DataPolicy, type ResearchScope, type ReadingSnapshot, type ResearchRun,
  type EvidenceRevision,
} from './contracts.ts';

export function sameScope(a: ResearchScope, b: ResearchScope): boolean {
  return a.kind === 'personal' ? b.kind === 'personal' && a.ownerId === b.ownerId :
    b.kind === 'project' && a.projectId === b.projectId;
}
export function assertScopeAccess(actorInput: unknown, scopeInput: unknown, memberInput: unknown,
  action: 'read' | 'write' | 'manage'): void {
  const actor = parseContract(ActorSchema, actorInput);
  const scope = parseContract(ScopeSchema, scopeInput);
  parseContract(z.enum(['read', 'write', 'manage']), action);
  if (!actor.active) throw new ResearchError('BIO_ACCESS_DENIED');
  if (scope.kind === 'personal') {
    if (scope.ownerId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED');
    return;
  }
  const result = MembershipSchema.safeParse(memberInput);
  const member = result.success ? result.data : null;
  if (!member?.active || member.projectId !== scope.projectId || member.userId !== actor.userId ||
      (action === 'write' && member.role === 'viewer') || (action === 'manage' && member.role !== 'owner')) {
    throw new ResearchError('BIO_ACCESS_DENIED');
  }
}
export function assertSessionControl(actorInput: unknown, sessionInput: unknown, memberInput: unknown, action: 'execute' | 'cancel' = 'execute'): void {
  const actor = parseContract(ActorSchema, actorInput);
  const session = parseContract(SessionSchema, sessionInput);
  parseContract(z.enum(['execute', 'cancel']), action);
  assertScopeAccess(actor, session.scope, memberInput, action === 'execute' ? 'write' : 'read');
  if (session.ownerId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED');
}
export function mergePolicies(input: unknown): DataPolicy {
  const policies = parseContract(z.array(PolicySchema), input);
  return policies.includes('restricted') ? 'restricted' :
    policies.length === 0 || policies.includes('unknown') ? 'unknown' : 'public';
}
export function mergeSessionPolicy(currentInput: unknown, selectedInput: unknown): DataPolicy {
  const current = parseContract(PolicySchema, currentInput);
  const selected = parseContract(z.array(PolicySchema).max(1000), selectedInput);
  return mergePolicies([current, ...selected]);
}
// Only pass repository-resolved resources here; the RPC schemas accept IDs, not classifications.
export function assertPublicContext(input: unknown): void {
  const resources = parseContract(z.array(ResourcePolicySchema).max(1000), input);
  if (new Set(resources.map(resource => resource.id)).size !== resources.length ||
      mergePolicies(resources.map(resource => resource.policy)) !== 'public') {
    throw new ResearchError('BIO_POLICY_DENIED');
  }
}
export function validateSnapshot(input: unknown): ReadingSnapshot { return parseContract(SnapshotSchema, input); }
export function assertSnapshotSource(snapshotInput: unknown, sourceInput: unknown): void {
  const snapshot = validateSnapshot(snapshotInput);
  const source = parseContract(SourceSchema, sourceInput);
  if (snapshot.sourceId !== source.id || !sameScope(snapshot.scope, source.scope) || snapshot.policy !== source.policy) {
    throw new ResearchError('BIO_ACCESS_DENIED');
  }
}
export type CitationCheck = { status: 'structure-valid' } | {
  status: 'pending'; reason: 'invalid-reference' | 'snapshot-mismatch' | 'block-missing' | 'excerpt-mismatch';
};
export function validateCitation(snapshotInput: unknown, citationInput: unknown): CitationCheck {
  const snapshot = SnapshotSchema.safeParse(snapshotInput);
  const citation = CitationSchema.safeParse(citationInput);
  if (!snapshot.success || !citation.success) return { status: 'pending', reason: 'invalid-reference' };
  const ref = citation.data;
  if (ref.snapshotId !== snapshot.data.id) return { status: 'pending', reason: 'snapshot-mismatch' };
  const block = snapshot.data.blocks.find(item => item.id === ref.blockId);
  if (!block) return { status: 'pending', reason: 'block-missing' };
  if (ref.end > block.text.length || block.text.slice(ref.start, ref.end) !== ref.quote) {
    return { status: 'pending', reason: 'excerpt-mismatch' };
  }
  return { status: 'structure-valid' };
}
export function assertRevision(currentInput: unknown, expectedInput: unknown): void {
  const current = parseContract(RevisionSchema, currentInput);
  const expected = parseContract(RevisionSchema, expectedInput);
  if (current !== expected) throw new ResearchError('BIO_REVISION_CONFLICT');
}
export function reviseEvidence(previousInput: unknown, changesInput: unknown, expectedInput: unknown,
  newIdInput: unknown, authorIdInput: unknown, nowInput: unknown): EvidenceRevision {
  const previous = parseContract(EvidenceRevisionSchema, previousInput);
  assertRevision(previous.revision, expectedInput);
  const changes = parseContract(z.strictObject({
    claim: nonBlankText(20000), citations: z.array(CitationSchema).min(1).max(100),
  }), changesInput);
  const id = parseContract(IdSchema, newIdInput);
  const createdAt = parseContract(TimestampSchema, nowInput);
  if (id === previous.id || createdAt < previous.createdAt) throw new ResearchError('BIO_INPUT_INVALID');
  const { review: _previousReview, ...oldContent } = previous;
  return parseContract(EvidenceRevisionSchema, {
    ...oldContent, ...changes, id, authorId: parseContract(IdSchema, authorIdInput),
    createdAt, revision: previous.revision + 1,
    structuralStatus: 'pending', reviewStatus: 'unreviewed',
  });
}
export function transitionRun(input: unknown, nextInput: unknown, expectedInput: unknown, nowInput: unknown = Date.now(), leaseInput?: unknown): ResearchRun {
  const run = parseContract(RunSchema, input);
  const next = parseContract(RunStateSchema, nextInput);
  const expected = parseContract(GenerationSchema, expectedInput);
  const now = parseContract(TimestampSchema, nowInput);
  if (run.generation !== expected) throw new ResearchError('BIO_REVISION_CONFLICT');
  if (run.state === 'running' && next === 'completed' && run.lease && now >= run.lease.expiresAt) {
    throw new ResearchError('BIO_REVISION_CONFLICT');
  }
  const allowed = run.state === 'queued' ? ['running', 'failed', 'cancelled', 'interrupted'] :
    run.state === 'running' ? ['completed', 'failed', 'cancelled', 'interrupted'] : [];
  if (!allowed.includes(next)) throw new ResearchError('BIO_INVALID_TRANSITION');
  const { lease: _previousLease, ...withoutLease } = run;
  return parseContract(RunSchema, {
    ...withoutLease, state: next, revision: run.revision + 1,
    generation: run.generation + (next === 'cancelled' || next === 'interrupted' ? 1 : 0),
    ...(next === 'running' ? { startedAt: now, lease: parseContract(RunLeaseSchema, leaseInput) } : { finishedAt: now }),
  });
}
