import { z } from 'zod'
import { PublicModelInputSchema, ResearchModelSchema, IdSchema, ResearchExecutionModeSchema, ResearchToolEventSchema } from '@bio-evidence/research-core'
import type { ResearchExecutionMode, ResearchToolEvent } from '@bio-evidence/research-core'
export interface PublicExecutionControl { mode: ResearchExecutionMode; toolEvent(event: ResearchToolEvent): Promise<void> }
export const PublicPiJobSchema = z.strictObject({ purpose: z.enum(['evidence', 'report']), input: PublicModelInputSchema, apiKey: z.string().min(1).max(8192), executionMode: ResearchExecutionModeSchema.optional(),
  connection: z.strictObject({ api: z.enum(['openai-responses', 'openai-completions']), baseUrl: z.string().url(), model: ResearchModelSchema }) })
export type PublicPiJob = z.infer<typeof PublicPiJobSchema>
export const PublicPiStartSchema = z.strictObject({ type: z.literal('start'), job: PublicPiJobSchema, mode: z.enum(['generate', 'inspect']).default('generate') })
export const PublicModelAttemptSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('send'), callId: IdSchema }),
  z.strictObject({ phase: z.literal('received'), callId: IdSchema, outcome: z.enum(['completed', 'rejected']) }),
])
export type PublicModelAttempt = z.infer<typeof PublicModelAttemptSchema>
export const PublicPiCheckSchema = z.union([
  z.strictObject({ type: z.literal('check'), id: IdSchema, kind: z.enum(['model', 'tool']) }),
  z.strictObject({ type: z.literal('check'), id: IdSchema, kind: z.literal('attempt'), attempt: PublicModelAttemptSchema }),
  z.strictObject({ type: z.literal('check'), id: IdSchema, kind: z.literal('tool-event'), event: ResearchToolEventSchema }),
])
export const PublicPiResultSchema = z.strictObject({ type: z.literal('result'), text: z.string().min(1).max(262144) })
export const PublicPiErrorCodeSchema = z.enum(['BIO_MODEL_UNAVAILABLE', 'BIO_MODEL_AUTH_FAILED', 'BIO_MODEL_RATE_LIMITED', 'BIO_MODEL_TIMEOUT', 'BIO_MODEL_UNSUPPORTED', 'BIO_MODEL_CANCELLED', 'BIO_MODEL_BUDGET', 'BIO_CONNECTION_INVALID', 'BIO_POLICY_DENIED', 'BIO_ACCESS_DENIED', 'BIO_INPUT_INVALID', 'BIO_STORAGE_UNAVAILABLE'])
export const PublicPiOutputSchema = z.union([PublicPiCheckSchema, PublicPiResultSchema, z.strictObject({ type: z.literal('error'), code: PublicPiErrorCodeSchema })])
export const PublicPiReplySchema = z.strictObject({ type: z.enum(['allow', 'deny']), id: IdSchema })
