import { z } from 'zod'
import { PublicModelInputSchema, ResearchModelSchema, IdSchema } from '@bio-evidence/research-core'
export const PublicPiJobSchema = z.strictObject({ purpose: z.enum(['evidence', 'report']), input: PublicModelInputSchema, apiKey: z.string().min(1).max(8192),
  connection: z.strictObject({ api: z.enum(['openai-responses', 'openai-completions']), baseUrl: z.string().url(), model: ResearchModelSchema }) })
export type PublicPiJob = z.infer<typeof PublicPiJobSchema>
export const PublicPiStartSchema = z.strictObject({ type: z.literal('start'), job: PublicPiJobSchema, mode: z.enum(['generate', 'inspect']).default('generate') })
export const PublicPiCheckSchema = z.strictObject({ type: z.literal('check'), id: IdSchema, kind: z.enum(['model', 'tool']) })
export const PublicPiResultSchema = z.strictObject({ type: z.literal('result'), text: z.string().min(1).max(262144) })
export const PublicPiErrorCodeSchema = z.enum(['BIO_MODEL_UNAVAILABLE', 'BIO_MODEL_AUTH_FAILED', 'BIO_MODEL_RATE_LIMITED', 'BIO_MODEL_TIMEOUT', 'BIO_MODEL_UNSUPPORTED', 'BIO_MODEL_CANCELLED', 'BIO_MODEL_BUDGET', 'BIO_CONNECTION_INVALID', 'BIO_POLICY_DENIED', 'BIO_ACCESS_DENIED', 'BIO_INPUT_INVALID'])
export const PublicPiOutputSchema = z.union([PublicPiCheckSchema, PublicPiResultSchema, z.strictObject({ type: z.literal('error'), code: PublicPiErrorCodeSchema })])
export const PublicPiReplySchema = z.strictObject({ type: z.enum(['allow', 'deny']), id: IdSchema })
