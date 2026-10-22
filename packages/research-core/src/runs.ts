import { z } from 'zod'
import { GenerationSchema, IdSchema, RevisionSchema, RunSchema, ScopeSchema, ResearchError, parseContract } from './contracts'
import { PublicInputRequestSchema, PublicModelInputSchema } from './public-research'

export const ResearchPurposeSchema = z.enum(['evidence', 'report'])
export const ResearchExecutionModeSchema = z.enum(['safe', 'ask', 'allow-all'])
export type ResearchExecutionMode = z.infer<typeof ResearchExecutionModeSchema>
export const ResearchToolReferenceSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('get_public_block'), arguments: z.strictObject({ snapshotId: IdSchema, blockId: IdSchema }) }),
  z.strictObject({ name: z.literal('get_public_evidence'), arguments: z.strictObject({ revisionId: IdSchema }) }),
])
export type ResearchToolReference = z.infer<typeof ResearchToolReferenceSchema>
export function assertPublicToolReference(raw: unknown, input: z.infer<typeof PublicModelInputSchema>): ResearchToolReference {
  const ref = parseContract(ResearchToolReferenceSchema, raw)
  if (ref.name === 'get_public_block' ? !input.blocks.some(item => item.snapshotId === ref.arguments.snapshotId && item.blockId === ref.arguments.blockId) : !input.evidence.some(item => item.id === ref.arguments.revisionId)) throw new ResearchError('BIO_ACCESS_DENIED')
  return ref
}
export const ResearchToolEventSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('request'), id: IdSchema, reference: ResearchToolReferenceSchema }),
  z.strictObject({ phase: z.literal('completed'), id: IdSchema, isError: z.boolean() }),
])
export type ResearchToolEvent = z.infer<typeof ResearchToolEventSchema>
export const ResearchTraceSchema = z.strictObject({ id: IdSchema, sequence: z.number().int().min(1).max(64), kind: z.enum(['guard', 'model', 'tool', 'validate']),
  state: z.enum(['pending', 'approved', 'completed', 'failed', 'denied', 'interrupted']), startedAt: GenerationSchema, finishedAt: GenerationSchema.optional(), reference: ResearchToolReferenceSchema.optional() })
export type ResearchTrace = z.infer<typeof ResearchTraceSchema>
export const DecideResearchToolSchema = z.strictObject({ runId: IdSchema, expectedGeneration: GenerationSchema, requestId: IdSchema, decision: z.enum(['approve', 'deny']) })
// Absence is preserved for the fingerprints of existing accepted requests.
export const StartResearchRunSchema = PublicInputRequestSchema.extend({ purpose: ResearchPurposeSchema, expectedRevision: RevisionSchema, operationId: IdSchema, retryOfRunId: IdSchema.optional(), executionMode: ResearchExecutionModeSchema.optional() })
export type StartResearchRun = z.infer<typeof StartResearchRunSchema>
export const PublicInputManifestSchema = z.strictObject({ id: IdSchema, sessionId: IdSchema, sessionRevision: RevisionSchema, scope: ScopeSchema,
  actorId: IdSchema, declaredAt: GenerationSchema, policyVersion: z.literal(1), contextHash: z.string().regex(/^[a-f0-9]{64}$/), connectionId: IdSchema, model: PublicInputRequestSchema.shape.model })
export const ResearchRunViewSchema = z.strictObject({ run: RunSchema, operationId: IdSchema, purpose: ResearchPurposeSchema, manifest: PublicInputManifestSchema,
  input: PublicModelInputSchema,
  modelRequests: z.array(z.strictObject({ callId: IdSchema, state: z.enum(['pending', 'completed', 'rejected', 'unknown']) })).max(4),
  projectionPending: z.boolean(),
  projectionStatus: z.enum(['none', 'pending', 'projected', 'covered']),
  executionMode: ResearchExecutionModeSchema.optional(), connectionRevision: RevisionSchema.optional(), trace: z.array(ResearchTraceSchema).max(64).optional(),
  steps: z.array(z.strictObject({ id: IdSchema, state: z.enum(['completed', 'failed']) })).max(8),
  errorCode: z.string().regex(/^BIO_[A-Z_]+$/).optional() })
export type ResearchRunView = z.infer<typeof ResearchRunViewSchema>
export const ResearchRunPageSchema = z.strictObject({ items: z.array(RunSchema).max(100), nextCursor: IdSchema.optional() })
