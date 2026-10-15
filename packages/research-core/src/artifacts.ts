import { z } from 'zod'
import { EvidenceRevisionSchema, ReportRevisionSchema, IdSchema, PolicySchema, CitationSchema, RevisionSchema, nonBlankText, ReportTitleSchema, ReportClaimSchema, IdListSchema } from './contracts'
export const EvidenceEditContentSchema = z.strictObject({ claim: nonBlankText(20000), citations: z.array(CitationSchema).min(1).max(100), declaredPublic: z.boolean().default(false),
  factSummary: z.string().max(20000).default(''), limitations: z.string().max(20000).default(''), missingInformation: z.array(z.string().max(2000)).max(50).default([]) })
export const CreateEvidenceRequestSchema = EvidenceEditContentSchema.extend({ sessionId: IdSchema })
export const SaveEvidenceRequestSchema = EvidenceEditContentSchema.extend({ evidenceId: IdSchema, expectedRevision: RevisionSchema })
export const ReportContextSchema = z.strictObject({ researchQuestion: z.string().max(20000).default(''), materialScope: z.string().max(20000).default(''),
  limitations: z.string().max(20000).default(''), missingInformation: z.array(z.string().max(2000)).max(50).default([]) })
export const CreateReportRequestSchema = ReportContextSchema.extend({ sessionId: IdSchema, title: ReportTitleSchema, claims: z.array(ReportClaimSchema).max(1000), declaredPublic: z.boolean().default(false) })
export const SaveReportRequestSchema = ReportContextSchema.extend({ reportId: IdSchema, expectedRevision: RevisionSchema, title: ReportTitleSchema, markdown: z.string().max(1000000), evidenceRevisionIds: IdListSchema,
  claims: z.array(ReportClaimSchema).max(1000).default([]), declaredPublic: z.boolean().default(false) })
export const ChangedSourceSchema = z.strictObject({ snapshotId: IdSchema, sourceId: IdSchema, currentSourceId: IdSchema })
export const EvidenceViewSchema = z.strictObject({ revision: EvidenceRevisionSchema, effectivePolicy: PolicySchema, changedSources: z.array(ChangedSourceSchema).max(100), unresolvedMetadataSourceIds: z.array(IdSchema).max(200) })
export const ReportViewSchema = z.strictObject({ revision: ReportRevisionSchema, effectivePolicy: PolicySchema, changedSources: z.array(ChangedSourceSchema).max(10000),
  changedEvidenceRevisions: z.array(z.strictObject({ evidenceRevisionId: IdSchema, currentRevisionId: IdSchema })).max(1000), unresolvedMetadataSourceIds: z.array(IdSchema).max(20000) })
export const ArtifactExportSchema = z.strictObject({ format: z.enum(['csv', 'markdown']), filename: z.string().regex(/^[A-Za-z0-9_-]+\.(?:csv|md)$/),
  mediaType: z.enum(['text/csv; charset=utf-8', 'text/markdown; charset=utf-8']), content: z.string().max(8 * 1024 * 1024), policy: PolicySchema })
export type EvidenceView = z.infer<typeof EvidenceViewSchema>
export type ReportView = z.infer<typeof ReportViewSchema>
export type ArtifactExport = z.infer<typeof ArtifactExportSchema>
export const ArtifactSummarySchema = z.strictObject({ id: IdSchema, entityId: IdSchema, sessionId: IdSchema, revision: RevisionSchema,
  title: z.string().max(300), policy: PolicySchema, structuralStatus: z.enum(['pending', 'structure-valid']), reviewStatus: z.enum(['unreviewed', 'confirmed', 'needs-changes']),
  authorId: IdSchema, createdAt: z.number().int().nonnegative() })
export const ArtifactPageSchema = z.strictObject({ items: z.array(z.strictObject({ kind: z.enum(['evidence', 'report']), value: ArtifactSummarySchema })).max(200), nextCursor: z.string().max(256).optional() })
export type ArtifactPage = z.infer<typeof ArtifactPageSchema>
