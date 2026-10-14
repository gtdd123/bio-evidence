import { z } from 'zod'
import { CoverageSchema, TextBlockSchema, SourceSchema, SessionSchema, SnapshotSchema, IdSchema, RevisionSchema } from './contracts'
export const DocumentBudgetsSchema = z.strictObject({
  pdfMaxBytes: z.number().int().min(1).max(25 * 1024 * 1024).default(25 * 1024 * 1024),
  pdfMaxPages: z.number().int().min(1).max(100).default(100),
  maxTextChars: z.number().int().min(1).max(5000000).default(5000000),
  xmlMaxBytes: z.number().int().min(1).max(10 * 1024 * 1024).default(10 * 1024 * 1024),
  xmlMaxDepth: z.number().int().min(1).max(64).default(64),
  xmlMaxNodes: z.number().int().min(1).max(100000).default(100000),
  timeoutMs: z.number().int().min(1).max(30000).default(30000),
})
export type DocumentBudgets = z.output<typeof DocumentBudgetsSchema>
export const ParsedDocumentSchema = z.strictObject({
  status: z.literal('ok'), format: z.enum(['pdf', 'jats']), coverage: CoverageSchema,
  blocks: z.array(TextBlockSchema).max(10000),
})
export const DocumentFailureSchema = z.strictObject({ status: z.enum(['invalid', 'encrypted', 'unsupported', 'budget', 'cancelled', 'timeout', 'busy', 'unavailable']) })
export const ParsedDocumentResultSchema = z.discriminatedUnion('status', [ParsedDocumentSchema, DocumentFailureSchema])
export type ParsedDocumentResult = z.infer<typeof ParsedDocumentResultSchema>
export const DocumentIngestResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), source: SourceSchema, session: SessionSchema, snapshot: SnapshotSchema }),
  DocumentFailureSchema,
])
export type DocumentIngestResult = z.infer<typeof DocumentIngestResultSchema>
export const ImportPdfRequestSchema = z.strictObject({ sessionId: IdSchema, expectedRevision: RevisionSchema, declaredPublic: z.boolean().default(false) })
