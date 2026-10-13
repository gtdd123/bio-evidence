import { z } from 'zod'
import { IdSchema, SourceSchema, SessionSchema, SnapshotSchema, TimestampSchema, ResearchError, type ResearchSource } from './contracts'
export const LiteratureBudgetsSchema = z.strictObject({
  maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).default(10 * 1024 * 1024),
  timeoutMs: z.number().int().min(1).max(30000).default(30000),
})
export const LiteratureRecordSchema = z.strictObject({ provider: z.literal('europe-pmc'), providerId: z.string().min(1).max(1000),
  identifiers: SourceSchema.shape.identifiers, title: SourceSchema.shape.title, authors: SourceSchema.shape.authors,
  year: SourceSchema.shape.year, abstract: SourceSchema.shape.abstract, license: SourceSchema.shape.license,
  availability: z.strictObject({ abstract: z.boolean(), fullText: z.boolean() }) })
export type PublicLiteratureRecord = z.infer<typeof LiteratureRecordSchema>
export const LiteratureCandidateSchema = LiteratureRecordSchema.extend({ id: IdSchema, sessionId: IdSchema, retrievedAt: TimestampSchema })
export type LiteratureCandidate = z.infer<typeof LiteratureCandidateSchema>
export const LiteratureSearchPageSchema = z.strictObject({ items: z.array(LiteratureCandidateSchema).max(50), nextCursor: z.string().max(2000).optional() })
export type LiteratureSearchPage = z.infer<typeof LiteratureSearchPageSchema>
export const LiteratureSelectionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('selected'), source: SourceSchema, session: SessionSchema, snapshot: SnapshotSchema.optional(), created: z.boolean() }),
  z.strictObject({ status: z.literal('identity-conflict'), candidates: z.array(SourceSchema).min(2).max(100) }),
])
export type LiteratureSelection = z.infer<typeof LiteratureSelectionSchema>
export function canonicalIdentifiers(input: ResearchSource['identifiers']): ResearchSource['identifiers'] {
  const result: ResearchSource['identifiers'] = {}
  if (input.doi) {
    const value = input.doi.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '').toLowerCase()
    if (!/^10\.\d{4,9}\/[^\s]+$/.test(value) || value.length > 1000) throw new ResearchError('BIO_INPUT_INVALID')
    result.doi = value
  }
  if (input.pmid) {
    const value = input.pmid.trim().replace(/^0+(?=\d)/, '')
    if (!/^[1-9]\d{0,99}$/.test(value)) throw new ResearchError('BIO_INPUT_INVALID')
    result.pmid = value
  }
  if (input.pmcid) {
    const value = input.pmcid.trim().toUpperCase()
    if (!/^PMC[1-9]\d{0,96}$/.test(value)) throw new ResearchError('BIO_INPUT_INVALID')
    result.pmcid = value
  }
  if (input.providerId) {
    if (!/^[A-Z][A-Z0-9_-]{0,15}:[A-Za-z0-9_.-]{1,128}$/.test(input.providerId)) throw new ResearchError('BIO_INPUT_INVALID')
    result.providerId = input.providerId
  }
  return result
}
