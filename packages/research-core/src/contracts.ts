import { z } from 'zod';

export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const RevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const GenerationSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const TimestampSchema = GenerationSchema;
export const ReportTitleSchema = z.string().max(300).refine(value => value.trim().length > 0 && !/[\r\n]/.test(value));
export const nonBlankText = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0);
export const PolicySchema = z.enum(['public', 'restricted', 'unknown']);
export type DataPolicy = z.infer<typeof PolicySchema>;
export const IdListSchema = z.array(IdSchema).max(1000).refine(ids => new Set(ids).size === ids.length);
export const ScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('personal'), ownerId: IdSchema }),
  z.strictObject({ kind: z.literal('project'), projectId: IdSchema }),
]);
export type ResearchScope = z.infer<typeof ScopeSchema>;

// Actor and classifications are server authority records, never client grants.
export const ActorSchema = z.strictObject({
  userId: IdSchema, authSessionId: IdSchema, administrator: z.boolean(), active: z.boolean(),
});
export type Actor = z.infer<typeof ActorSchema>;
export const MembershipSchema = z.strictObject({
  projectId: IdSchema, userId: IdSchema, role: z.enum(['owner', 'editor', 'viewer']), active: z.boolean(),
});
export type Membership = z.infer<typeof MembershipSchema>;
export const ResourcePolicySchema = z.strictObject({ id: IdSchema, policy: PolicySchema });
export const LicenseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unknown') }),
  z.strictObject({ status: z.literal('known'), identifier: z.string().min(1).max(1000),
    url: z.string().url().max(2000).refine(value => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    }).optional(), redistribution: z.enum(['allowed', 'prohibited', 'unknown']),
  }),
]);
export type ArticleLicense = z.infer<typeof LicenseSchema>;

export const SourceSchema = z.strictObject({
  id: IdSchema, scope: ScopeSchema, policy: PolicySchema, license: LicenseSchema,
  provider: z.enum(['europe-pmc', 'pdf-import']),
  title: z.string().max(2000).optional(), authors: z.array(z.string().max(500)).max(1000).optional(),
  year: z.number().int().min(0).max(9999).optional(), abstract: z.string().max(1000000).optional(),
  identifiers: z.strictObject({
    doi: z.string().min(1).max(1000).optional(), pmid: z.string().min(1).max(100).optional(),
    pmcid: z.string().min(1).max(100).optional(), providerId: z.string().min(1).max(1000).optional(),
  }),
  createdAt: TimestampSchema,
  sourceIdentityId: IdSchema.optional(), revision: RevisionSchema.optional(), predecessorId: IdSchema.optional(),
  retrievedAt: TimestampSchema.optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  availability: z.strictObject({ abstract: z.boolean().optional(), fullText: z.boolean().optional() }).optional(),
  metadataConflictFields: z.array(z.enum(['title', 'authors', 'year', 'abstract', 'identifiers', 'license', 'provider'])).max(7).optional(),
  declaration: z.strictObject({ actorId: IdSchema, declaredAt: TimestampSchema, kind: z.enum(['explicit-public-pdf', 'public-provider']) }).optional(),
  metadataReview: z.strictObject({ sourceId: IdSchema, sourceRevision: RevisionSchema, reviewerId: IdSchema, reviewedAt: TimestampSchema }).optional(),
}).superRefine((value, ctx) => {
  if (Boolean(value.sourceIdentityId) !== Boolean(value.revision) || (!value.revision && value.predecessorId !== undefined) ||
    (value.revision === 1 ? value.predecessorId !== undefined : value.revision !== undefined && !value.predecessorId) ||
    value.declaration && (value.policy !== 'public' || value.declaration.declaredAt > value.createdAt ||
      (value.declaration.kind === 'explicit-public-pdf' ? value.provider !== 'pdf-import' : value.provider !== 'europe-pmc'))) {
    ctx.addIssue({ code: 'custom', message: 'Source revision and declaration must match provenance.' });
  }
  if (value.metadataReview && (value.metadataReview.sourceId !== value.id || value.metadataReview.sourceRevision !== (value.revision ?? 1) || value.metadataReview.reviewedAt < value.createdAt)) ctx.addIssue({ code: 'custom', message: 'Metadata review must bind to this source record.' });
});
export type ResearchSource = z.infer<typeof SourceSchema>;

export const LocatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pdf-page'), page: z.number().int().min(1).max(100) }),
  z.strictObject({ kind: z.literal('jats-paragraph'), paragraphId: IdSchema, section: z.string().max(1000).optional(),
    elementId: z.string().min(1).max(4096).optional(), sectionId: z.string().min(1).max(4096).optional() }),
  z.strictObject({ kind: z.literal('abstract') }),
]);
export const TextBlockSchema = z.strictObject({
  id: IdSchema, unit: z.number().int().min(1).max(10000), text: nonBlankText(200000), locator: LocatorSchema,
});
export type TextBlock = z.infer<typeof TextBlockSchema>;
const UnitSchema = z.strictObject({
  unit: z.number().int().min(1).max(10000), status: z.enum(['read', 'no-text', 'failed', 'unsupported']),
  reason: z.enum(['scan-or-empty', 'decode-failed', 'budget', 'unsupported-content']).optional(),
});
export const CoverageSchema = z.strictObject({
  level: z.enum(['abstract', 'partial', 'full']), totalUnits: z.number().int().min(1).max(10000),
  units: z.array(UnitSchema).min(1).max(10000),
}).superRefine((value, ctx) => {
  const indices = new Set(value.units.map(unit => unit.unit));
  if (indices.size !== value.totalUnits || value.units.length !== value.totalUnits ||
      value.units.some(unit => unit.unit > value.totalUnits)) {
    ctx.addIssue({ code: 'custom', message: 'Coverage must account for each unit exactly once.' });
  }
  if (value.level === 'full' && value.units.some(unit => unit.status !== 'read')) {
    ctx.addIssue({ code: 'custom', message: 'Unread units cannot be full coverage.' });
  }
});
export const SnapshotSchema = z.strictObject({
  id: IdSchema, sourceId: IdSchema, scope: ScopeSchema, policy: PolicySchema, license: LicenseSchema,
  format: z.enum(['pdf', 'jats', 'abstract']),
  acquiredBy: z.enum(['declared-public-pdf', 'private-pdf', 'europe-pmc-oa', 'europe-pmc-abstract']),
  retrievedAt: TimestampSchema, contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: CoverageSchema, blocks: z.array(TextBlockSchema).max(10000),
}).superRefine((value, ctx) => {
  const blockIds = new Set(value.blocks.map(block => block.id));
  const readUnits = new Set(value.coverage.units.filter(unit => unit.status === 'read').map(unit => unit.unit));
  const representedUnits = new Set(value.blocks.map(block => block.unit));
  const paragraphIds = value.blocks.flatMap(block => block.locator.kind === 'jats-paragraph' ? [block.locator.paragraphId] : []);
  const invalid = blockIds.size !== value.blocks.length ||
    new Set(paragraphIds).size !== paragraphIds.length ||
    value.blocks.some(block => !readUnits.has(block.unit) ||
      (value.format === 'pdf' ? block.locator.kind !== 'pdf-page' || block.locator.page !== block.unit :
        value.format === 'jats' ? block.locator.kind !== 'jats-paragraph' : block.locator.kind !== 'abstract')) ||
    [...readUnits].some(unit => !representedUnits.has(unit)) ||
    (value.format === 'pdf' && value.coverage.totalUnits > 100) ||
    (value.format === 'abstract' && (value.coverage.level !== 'abstract' || value.coverage.totalUnits !== 1)) ||
    (value.acquiredBy === 'private-pdf' && (value.format !== 'pdf' || value.policy !== 'restricted')) ||
    (value.acquiredBy === 'declared-public-pdf' && (value.format !== 'pdf' || value.policy !== 'public')) ||
    (value.acquiredBy === 'europe-pmc-oa' && (value.format !== 'jats' || value.policy !== 'public')) ||
    (value.acquiredBy === 'europe-pmc-abstract' && (value.format !== 'abstract' || value.policy !== 'public'));
  if (invalid) ctx.addIssue({ code: 'custom', message: 'Snapshot provenance, coverage and blocks must agree.' });
});
export type ReadingSnapshot = z.infer<typeof SnapshotSchema>;
export const CitationSchema = z.strictObject({
  snapshotId: IdSchema, blockId: IdSchema, start: GenerationSchema, end: RevisionSchema,
  quote: nonBlankText(200000),
}).refine(value => value.end > value.start);
export type Citation = z.infer<typeof CitationSchema>;
export const HumanReviewSchema = z.strictObject({
  reviewerId: IdSchema, reviewedAt: TimestampSchema, revisionId: IdSchema, revisionNumber: RevisionSchema,
});
type Reviewable = { id: string; revision: number; createdAt: number; structuralStatus: string; reviewStatus: string;
  review?: z.infer<typeof HumanReviewSchema> };
function checkReview(value: Reviewable, ctx: z.RefinementCtx): void {
  if ((value.reviewStatus === 'unreviewed') !== (value.review === undefined) ||
      (value.review && (value.review.revisionId !== value.id || value.review.revisionNumber !== value.revision || value.review.reviewedAt < value.createdAt)) ||
      (value.reviewStatus === 'confirmed' && value.structuralStatus !== 'structure-valid')) {
    ctx.addIssue({ code: 'custom', message: 'Human review must bind to this revision and valid structure.' });
  }
}
export const ResearchInputDeclarationSchema = z.strictObject({ actorId: IdSchema, declaredAt: TimestampSchema,
  kind: z.enum(['explicit-public-edit', 'generated-public-context']) });
function checkArtifactPolicy(value: { policy?: DataPolicy; declaration?: z.infer<typeof ResearchInputDeclarationSchema>; createdAt: number }, ctx: z.RefinementCtx) {
  if (value.declaration && (value.policy !== 'public' || value.declaration.declaredAt > value.createdAt)) ctx.addIssue({ code: 'custom', message: 'Public declaration must bind to a public revision.' });
}
export const EvidenceRevisionSchema = z.strictObject({
  id: IdSchema, evidenceId: IdSchema, scope: ScopeSchema, revision: RevisionSchema,
  sessionId: IdSchema.optional(), policy: PolicySchema.optional(), declaration: ResearchInputDeclarationSchema.optional(),
  claim: nonBlankText(20000), citations: z.array(CitationSchema).min(1).max(100),
  factSummary: z.string().max(20000).optional(), limitations: z.string().max(20000).optional(), missingInformation: z.array(z.string().max(2000)).max(50).optional(),
  structuralIssues: z.array(z.enum(['excerpt-mismatch', 'block-missing', 'source-metadata-conflict'])).max(3).optional(),
  structuralStatus: z.enum(['pending', 'structure-valid']),
  reviewStatus: z.enum(['unreviewed', 'confirmed', 'needs-changes']),
  review: HumanReviewSchema.optional(),
  authorId: IdSchema, createdAt: TimestampSchema,
}).superRefine((value, ctx) => {
  checkReview(value, ctx); checkArtifactPolicy(value, ctx);
  if (value.structuralStatus === 'structure-valid' && value.structuralIssues?.length) ctx.addIssue({ code: 'custom', message: 'Unresolved evidence issues cannot be structure valid.' });
});
export type EvidenceRevision = z.infer<typeof EvidenceRevisionSchema>;
export const ReportClaimSchema = z.strictObject({
  id: IdSchema, text: nonBlankText(20000), evidenceRevisionIds: IdListSchema,
  isInference: z.boolean().optional(),
});
// Structured reports render from the claims that were actually mapped. Free-form
// edits remain pending until their claims are mapped and checked again.
export function renderReportMarkdown(report: { title: string; claims: Array<{ text: string; evidenceRevisionIds: string[]; isInference?: boolean }> }): string {
  return `# ${report.title}\n\n${report.claims.map(claim =>
    `${claim.isInference ? '（推断）' : ''}${claim.text}\n\n依据：${claim.evidenceRevisionIds.map(id => `[${id}]`).join('、')}`,
  ).join('\n\n')}`;
}
export const ReportRevisionSchema = z.strictObject({
  id: IdSchema, reportId: IdSchema, scope: ScopeSchema, revision: RevisionSchema,
  sessionId: IdSchema.optional(), policy: PolicySchema.optional(), declaration: ResearchInputDeclarationSchema.optional(),
  title: ReportTitleSchema, markdown: z.string().max(1000000),
  researchQuestion: z.string().max(20000).optional(), materialScope: z.string().max(20000).optional(), limitations: z.string().max(20000).optional(),
  missingInformation: z.array(z.string().max(2000)).max(50).optional(),
  evidenceRevisionIds: IdListSchema, structuralStatus: z.enum(['pending', 'structure-valid']),
  claims: z.array(ReportClaimSchema).max(1000).default([]),
  reviewStatus: z.enum(['unreviewed', 'confirmed', 'needs-changes']),
  review: HumanReviewSchema.optional(),
  authorId: IdSchema, createdAt: TimestampSchema,
}).superRefine((value, ctx) => {
  checkReview(value, ctx);
  checkArtifactPolicy(value, ctx);
  const claimIds = new Set(value.claims.map(claim => claim.id));
  const referenced = new Set(value.claims.flatMap(claim => claim.evidenceRevisionIds));
  if (claimIds.size !== value.claims.length ||
      [...referenced].some(id => !value.evidenceRevisionIds.includes(id)) ||
      (value.structuralStatus === 'structure-valid' &&
        (value.markdown !== renderReportMarkdown(value) || value.claims.length === 0 || value.evidenceRevisionIds.length === 0 ||
          value.claims.some(claim => claim.evidenceRevisionIds.length === 0) ||
          value.evidenceRevisionIds.some(id => !referenced.has(id))))) {
    ctx.addIssue({ code: 'custom', message: 'Validated report claims must map to specific evidence revisions.' });
  }
});
export type ReportRevision = z.infer<typeof ReportRevisionSchema>;
export const RunStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
export type RunState = z.infer<typeof RunStateSchema>;
export const RunLeaseSchema = z.strictObject({
  runId: IdSchema, workerId: IdSchema, generation: GenerationSchema, expiresAt: TimestampSchema,
});
export type RunLease = z.infer<typeof RunLeaseSchema>;
export const RunSchema = z.strictObject({
  id: IdSchema, sessionId: IdSchema, scope: ScopeSchema, actorId: IdSchema, connectionId: IdSchema,
  state: RunStateSchema, generation: GenerationSchema, revision: RevisionSchema,
  lease: RunLeaseSchema.optional(),
  sourceIds: IdListSchema, artifactIds: IdListSchema,
  createdAt: TimestampSchema, startedAt: TimestampSchema.optional(), finishedAt: TimestampSchema.optional(),
  step: z.enum(['prepare', 'retrieve', 'parse', 'evidence', 'validate', 'report']).optional(),
}).superRefine((value, ctx) => {
  const terminal = !['queued', 'running'].includes(value.state);
  if (terminal !== (value.finishedAt !== undefined) ||
      (value.state === 'running' && value.startedAt === undefined) ||
      (value.state === 'queued' && value.startedAt !== undefined) ||
      ((value.state === 'running') !== (value.lease !== undefined)) ||
      (value.lease && (value.lease.runId !== value.id || value.lease.generation !== value.generation ||
        value.lease.expiresAt <= (value.startedAt ?? value.createdAt))) ||
      (value.startedAt !== undefined && value.startedAt < value.createdAt) ||
      (value.finishedAt !== undefined && value.finishedAt < (value.startedAt ?? value.createdAt))) {
    ctx.addIssue({ code: 'custom', message: 'Run timestamps must agree with state.' });
  }
});
export type ResearchRun = z.infer<typeof RunSchema>;
export const SessionSchema = z.strictObject({
  id: IdSchema, ownerId: IdSchema, scope: ScopeSchema, name: z.string().min(1).max(300), policy: PolicySchema,
  selectedSourceIds: IdListSchema.optional(),
  revision: RevisionSchema, createdAt: TimestampSchema,
}).refine(value => value.scope.kind !== 'personal' || value.ownerId === value.scope.ownerId);
export type ResearchSession = z.infer<typeof SessionSchema>;

export const BIO_ERROR_MESSAGES = {
  BIO_INPUT_INVALID: 'Invalid research input.',
  BIO_ACCESS_DENIED: 'Research access denied.',
  BIO_POLICY_DENIED: 'This context cannot be sent to a cloud model.',
  BIO_REVISION_CONFLICT: 'The revision has changed. Refresh before saving.',
  BIO_INVALID_TRANSITION: 'The research run cannot enter that state.',
  BIO_RUN_ACTIVE: 'This research session already has an active run.',
  BIO_STORAGE_UNAVAILABLE: 'Research storage is unavailable.',
  BIO_PROVIDER_RATE_LIMITED: 'The literature provider is rate limited. Retry later.',
  BIO_PROVIDER_TIMEOUT: 'The literature provider timed out. Retry the request.',
  BIO_PROVIDER_UNAVAILABLE: 'The literature provider is unavailable.',
  BIO_PROVIDER_BUDGET: 'The literature response exceeds the configured budget.',
  BIO_EXPORT_BUDGET: 'The research artifact or export exceeds the configured budget.',
  BIO_CONNECTION_INVALID: 'The selected research connection or model is unavailable.',
  BIO_MODEL_UNAVAILABLE: 'The selected model request could not complete.',
  BIO_MODEL_AUTH_FAILED: 'The selected model credentials were rejected.',
  BIO_MODEL_RATE_LIMITED: 'The selected model is rate limited. Retry later.',
  BIO_MODEL_TIMEOUT: 'The selected model request timed out.',
  BIO_MODEL_UNSUPPORTED: 'The selected model or endpoint does not support this request.',
  BIO_MODEL_CANCELLED: 'The selected model request was cancelled.',
  BIO_MODEL_BUDGET: 'The public model context exceeds the configured budget.',
} as const;
export type BioErrorCode = keyof typeof BIO_ERROR_MESSAGES;
export class ResearchError extends Error {
  constructor(readonly code: BioErrorCode) { super(BIO_ERROR_MESSAGES[code]); this.name = 'ResearchError'; }
}
export function parseContract<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ResearchError('BIO_INPUT_INVALID');
  return result.data;
}
