import { z } from 'zod'
import { IdSchema, RevisionSchema, GenerationSchema, ScopeSchema, LocatorSchema, CitationSchema, CoverageSchema, ReportClaimSchema, nonBlankText } from './contracts'
import { EvidenceEditContentSchema, CreateReportRequestSchema } from './artifacts'
export const ResearchModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
export const ResearchModelSchema = z.strictObject({ id: ResearchModelIdSchema, contextWindow: z.number().int().min(1024).max(2000000), maxOutputTokens: z.number().int().min(128).max(32000) })
export const DeploymentModelConnectionSchema = z.strictObject({ slug: IdSchema, name: nonBlankText(120), providerType: z.enum(['pi', 'pi_compat']),
  piAuthProvider: z.literal('openai').optional(), authType: z.literal('api_key'), baseUrl: z.string().url().max(2000).optional(),
  customEndpoint: z.strictObject({ api: z.enum(['openai-responses', 'openai-completions']) }).optional(),
  enabled: z.boolean(), revision: RevisionSchema, credentialId: IdSchema.optional(), scopes: z.array(ScopeSchema).min(1).max(1000), models: z.array(ResearchModelSchema).min(1).max(100) })
export type DeploymentModelConnection = z.infer<typeof DeploymentModelConnectionSchema>
export const ResearchConnectionRecordSchema = DeploymentModelConnectionSchema.extend({ id: IdSchema, scope: z.strictObject({ kind: z.literal('personal'), ownerId: IdSchema }),
  policy: z.literal('restricted'), credentialId: IdSchema, createdAt: GenerationSchema, updatedAt: GenerationSchema }).refine(value => value.id === value.slug && value.updatedAt >= value.createdAt)
export type ResearchConnectionRecord = z.infer<typeof ResearchConnectionRecordSchema>
export const SaveResearchConnectionSchema = z.strictObject({ configuration: DeploymentModelConnectionSchema.omit({ revision: true, credentialId: true }), expectedRevision: GenerationSchema,
  apiKey: z.string().min(1).max(8192).regex(/^[^\x00-\x20\x7f]+$/).optional() })
export const ResearchConnectionViewSchema = z.strictObject({ slug: IdSchema, name: nonBlankText(120), providerType: z.enum(['pi', 'pi_compat']), revision: RevisionSchema, enabled: z.boolean(),
  baseUrl: z.string(), api: z.enum(['openai-responses', 'openai-completions']), models: z.array(ResearchModelSchema).max(100), keyConfigured: z.boolean() })
export type ResearchConnectionView = z.infer<typeof ResearchConnectionViewSchema>
export const ResearchConnectionConfigurationSchema = z.strictObject({ configuration: SaveResearchConnectionSchema.shape.configuration,
  revision: RevisionSchema, keyConfigured: z.boolean() })
export type ResearchConnectionConfiguration = z.infer<typeof ResearchConnectionConfigurationSchema>
export const PublicInputRequestSchema = z.strictObject({ sessionId: IdSchema, connectionId: IdSchema, model: ResearchModelIdSchema, question: nonBlankText(32000), declaredPublic: z.literal(true),
  blocks: z.array(z.strictObject({ snapshotId: IdSchema, blockId: IdSchema, start: z.number().int().nonnegative(), end: z.number().int().positive() }).refine(value => value.end > value.start)).min(1).max(100),
  evidenceRevisionIds: z.array(IdSchema).max(100).default([]) })
export const PublicModelInputSchema = z.strictObject({ question: nonBlankText(32000), readingScope: z.literal('selected-excerpts-only'),
  blocks: z.array(z.strictObject({ snapshotId: IdSchema, sourceId: IdSchema, blockId: IdSchema, start: z.number().int().nonnegative(), end: z.number().int().positive(),
    text: nonBlankText(32000), locator: LocatorSchema, coverage: CoverageSchema.shape.level, totalUnits: z.number().int().positive(), selectedUnit: z.number().int().positive(),
    sourceTitle: z.string().max(2000).optional(), identifiers: z.record(z.string(), z.string()), metadataPending: z.boolean(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(100),
  evidence: z.array(z.strictObject({ id: IdSchema, claim: nonBlankText(20000), factSummary: z.string(), limitations: z.string(), missingInformation: z.array(z.string()), citations: z.array(CitationSchema), structuralStatus: z.enum(['pending', 'structure-valid']) })).max(100) })
export type PublicModelInput = z.infer<typeof PublicModelInputSchema>
export const PublicEvidenceCandidateSchema = EvidenceEditContentSchema.omit({ declaredPublic: true })
export const PublicReportCandidateSchema = CreateReportRequestSchema.omit({ sessionId: true, declaredPublic: true }).extend({ claims: z.array(ReportClaimSchema.extend({ isInference: z.boolean() })).min(1).max(1000) })
export const PublicCandidateResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('evidence'), content: PublicEvidenceCandidateSchema, structuralStatus: z.enum(['pending', 'structure-valid']), reviewStatus: z.literal('unreviewed') }),
  z.strictObject({ kind: z.literal('report'), content: PublicReportCandidateSchema, structuralStatus: z.enum(['pending', 'structure-valid']), reviewStatus: z.literal('unreviewed') }),
])
export type PublicCandidateResult = z.infer<typeof PublicCandidateResultSchema>
