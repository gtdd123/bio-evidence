import { z } from 'zod'
import { GenerationSchema, IdSchema, RevisionSchema, RunSchema, ScopeSchema } from './contracts'
import { PublicInputRequestSchema, PublicModelInputSchema } from './public-research'

export const ResearchPurposeSchema = z.enum(['evidence', 'report'])
export const StartResearchRunSchema = PublicInputRequestSchema.extend({ purpose: ResearchPurposeSchema, expectedRevision: RevisionSchema, operationId: IdSchema, retryOfRunId: IdSchema.optional() })
export type StartResearchRun = z.infer<typeof StartResearchRunSchema>
export const PublicInputManifestSchema = z.strictObject({ id: IdSchema, sessionId: IdSchema, sessionRevision: RevisionSchema, scope: ScopeSchema,
  actorId: IdSchema, declaredAt: GenerationSchema, policyVersion: z.literal(1), contextHash: z.string().regex(/^[a-f0-9]{64}$/), connectionId: IdSchema, model: PublicInputRequestSchema.shape.model })
export const ResearchRunViewSchema = z.strictObject({ run: RunSchema, operationId: IdSchema, purpose: ResearchPurposeSchema, manifest: PublicInputManifestSchema,
  input: PublicModelInputSchema,
  modelRequests: z.array(z.strictObject({ callId: IdSchema, state: z.enum(['pending', 'completed', 'rejected', 'unknown']) })).max(4),
  projectionPending: z.boolean(),
  projectionStatus: z.enum(['none', 'pending', 'projected', 'covered']),
  steps: z.array(z.strictObject({ id: IdSchema, state: z.enum(['completed', 'failed']) })).max(8),
  errorCode: z.string().regex(/^BIO_[A-Z_]+$/).optional() })
export type ResearchRunView = z.infer<typeof ResearchRunViewSchema>
export const ResearchRunPageSchema = z.strictObject({ items: z.array(RunSchema).max(100), nextCursor: IdSchema.optional() })
