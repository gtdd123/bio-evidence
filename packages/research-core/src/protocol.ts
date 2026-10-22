import { z } from 'zod';
import { IdSchema, IdListSchema, ScopeSchema, RevisionSchema, GenerationSchema, CitationSchema,
  parseContract, ResearchError, type ResearchScope, type ResearchSession, type ReadingSnapshot,
  type EvidenceRevision, type ReportRevision, type ResearchRun, type ResearchSource } from './contracts.ts';
import type { ResearchSpaceView, ResearchMemberView, ResearchAuditEntry } from './repository.ts';
import { ReportClaimSchema, ReportTitleSchema, nonBlankText } from './contracts.ts';
import { MaterialImageRequestSchema, type MaterialImageResult, type MaterialGrantView, type MaterialRoot, type MaterialPage, type MaterialSearchResult, type MaterialDirectoryState, type MaterialAnnotation } from './materials.ts';
import type { LiteratureSearchPage, LiteratureSelection } from './literature.ts';
import type { DocumentIngestResult, SourceSnapshotPage } from './documents.ts';
import { CreateEvidenceRequestSchema, SaveEvidenceRequestSchema, CreateReportRequestSchema, SaveReportRequestSchema,
  type EvidenceView, type ReportView, type ArtifactExport, type ArtifactPage } from './artifacts.ts';
import { SaveResearchConnectionSchema, type ResearchConnectionView, type ResearchConnectionConfiguration } from './public-research.ts';
import { StartResearchRunSchema, DecideResearchToolSchema, type ResearchRunView } from './runs.ts';

export const RESEARCH_PROTOCOL_VERSION = 1 as const;
export const RESEARCH_CHANNELS = {
  LIST_SPACES: 'research:v1:listSpaces', CREATE_PROJECT: 'research:v1:createProject',
  LIST_MEMBERS: 'research:v1:listMembers', INVITE_MEMBER: 'research:v1:inviteMember', SET_MEMBER: 'research:v1:setMember',
  READ_AUDIT: 'research:v1:readAudit',
  LIST_MODEL_CONNECTIONS: 'research:v1:listModelConnections', SAVE_MODEL_CONNECTION: 'research:v1:saveModelConnection',
  GET_MODEL_CONNECTION_CONFIGURATION: 'research:v1:getModelConnectionConfiguration',
  LIST_SOURCE_SNAPSHOTS: 'research:v1:listSourceSnapshots', LIST_ARTIFACT_REVISIONS: 'research:v1:listArtifactRevisions',
  LIST_MATERIAL_GRANTS: 'research:v1:listMaterialGrants', REGISTER_MATERIAL: 'research:v1:registerMaterial',
  LIST_MATERIALS: 'research:v1:listMaterials', GET_MATERIAL: 'research:v1:getMaterial',
  INDEX_MATERIAL_DIRECTORY: 'research:v1:indexMaterialDirectory', LIST_MATERIAL_DIRECTORY: 'research:v1:listMaterialDirectory',
  SEARCH_MATERIAL_TEXT: 'research:v1:searchMaterialText',
  GET_MATERIAL_INDEX: 'research:v1:getMaterialIndex', GET_MATERIAL_ANNOTATION: 'research:v1:getMaterialAnnotation', SAVE_MATERIAL_ANNOTATION: 'research:v1:saveMaterialAnnotation',
  GET_MATERIAL_IMAGE: 'research:v1:getMaterialImage',
  CREATE_SESSION: 'research:v1:createSession', GET_SESSION: 'research:v1:getSession',
  LIST_SESSIONS: 'research:v1:listSessions', SEARCH: 'research:v1:search',
  SELECT_SOURCE: 'research:v1:selectSource', GET_SOURCE: 'research:v1:getSource',
  READ_SOURCE_TEXT: 'research:v1:readSourceText', IMPORT_MATERIAL_PDF: 'research:v1:importMaterialPdf',
  CREATE_EVIDENCE: 'research:v1:createEvidence', CREATE_REPORT: 'research:v1:createReport', GET_EVIDENCE: 'research:v1:getEvidence', GET_REPORT: 'research:v1:getReport',
  LIST_ARTIFACTS: 'research:v1:listArtifacts', REVIEW_ARTIFACT: 'research:v1:reviewArtifact', CONFIRM_SOURCE_METADATA: 'research:v1:confirmSourceMetadata',
  EXPORT_EVIDENCE: 'research:v1:exportEvidence', EXPORT_REPORT: 'research:v1:exportReport',
  GET_SNAPSHOT: 'research:v1:getSnapshot', SAVE_EVIDENCE: 'research:v1:saveEvidence',
  SAVE_REPORT: 'research:v1:saveReport', START_RUN: 'research:v1:startRun',
  CANCEL_RUN: 'research:v1:cancelRun', GET_RUN: 'research:v1:getRun',
  LIST_RUNS: 'research:v1:listRuns',
  DECIDE_TOOL: 'research:v1:decideTool',
  EVENT: 'research:v1:event',
} as const;
export const CreateSessionSchema = z.strictObject({ scope: ScopeSchema, name: z.string().trim().min(1).max(300), sourceIds: IdListSchema.default([]) });
export const ResearchRequestSchemas = {
  [RESEARCH_CHANNELS.GET_MODEL_CONNECTION_CONFIGURATION]: z.strictObject({ connectionId: IdSchema }),
  [RESEARCH_CHANNELS.LIST_SOURCE_SNAPSHOTS]: z.strictObject({ sourceId: IdSchema, pageSize: z.number().int().min(1).max(100).default(20), cursor: IdSchema.optional() }),
  [RESEARCH_CHANNELS.LIST_ARTIFACT_REVISIONS]: z.strictObject({ kind: z.enum(['evidence', 'report']), entityId: IdSchema, pageSize: z.number().int().min(1).max(100).default(20), cursor: IdSchema.optional() }),
  [RESEARCH_CHANNELS.LIST_MODEL_CONNECTIONS]: z.strictObject({ scope: ScopeSchema }),
  [RESEARCH_CHANNELS.SAVE_MODEL_CONNECTION]: SaveResearchConnectionSchema,
  [RESEARCH_CHANNELS.GET_MATERIAL_IMAGE]: MaterialImageRequestSchema,
  [RESEARCH_CHANNELS.LIST_MATERIAL_GRANTS]: z.strictObject({ scope: ScopeSchema }),
  [RESEARCH_CHANNELS.REGISTER_MATERIAL]: z.strictObject({ grantId: IdSchema, relativeDir: z.string().max(4096).default('') }),
  [RESEARCH_CHANNELS.LIST_MATERIALS]: z.strictObject({ scope: ScopeSchema, cursor: IdSchema.optional(), pageSize: z.number().int().min(1).max(200).default(100) }),
  [RESEARCH_CHANNELS.GET_MATERIAL]: z.strictObject({ rootId: IdSchema }),
  [RESEARCH_CHANNELS.INDEX_MATERIAL_DIRECTORY]: z.strictObject({ rootId: IdSchema, relativeDir: z.string().max(4096).default('') }),
  [RESEARCH_CHANNELS.LIST_MATERIAL_DIRECTORY]: z.strictObject({ rootId: IdSchema, relativeDir: z.string().max(4096).default(''), cursor: z.string().max(8192).optional(), pageSize: z.number().int().min(1).max(200).default(100) }),
  [RESEARCH_CHANNELS.SEARCH_MATERIAL_TEXT]: z.strictObject({ rootId: IdSchema, query: z.string().trim().min(1).max(200) }),
  [RESEARCH_CHANNELS.GET_MATERIAL_INDEX]: z.strictObject({ rootId: IdSchema, relativeDir: z.string().max(4096).default('') }),
  [RESEARCH_CHANNELS.GET_MATERIAL_ANNOTATION]: z.strictObject({ rootId: IdSchema, relativeDir: z.string().max(4096).default(''), generation: GenerationSchema, fileId: IdSchema }),
  [RESEARCH_CHANNELS.SAVE_MATERIAL_ANNOTATION]: z.strictObject({ rootId: IdSchema, relativeDir: z.string().max(4096).default(''), generation: GenerationSchema, fileId: IdSchema,
    expectedRevision: GenerationSchema, note: z.string().max(5000), tags: z.array(z.string().trim().min(1).max(100)).max(20) }),
  [RESEARCH_CHANNELS.LIST_SPACES]: z.strictObject({}),
  [RESEARCH_CHANNELS.READ_AUDIT]: z.strictObject({ scope: ScopeSchema, pageSize: z.number().int().min(1).max(200).default(100), afterSequence: GenerationSchema.default(0) }),
  [RESEARCH_CHANNELS.CREATE_PROJECT]: z.strictObject({ name: z.string().trim().min(1).max(300) }),
  [RESEARCH_CHANNELS.LIST_MEMBERS]: z.strictObject({ projectId: IdSchema }),
  [RESEARCH_CHANNELS.INVITE_MEMBER]: z.strictObject({ projectId: IdSchema, username: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
    role: z.enum(['owner', 'editor', 'viewer']), expectedRevision: RevisionSchema }),
  [RESEARCH_CHANNELS.SET_MEMBER]: z.strictObject({ projectId: IdSchema, userId: IdSchema,
    role: z.enum(['owner', 'editor', 'viewer']), active: z.boolean(), expectedRevision: RevisionSchema }),
  [RESEARCH_CHANNELS.CREATE_SESSION]: CreateSessionSchema,
  [RESEARCH_CHANNELS.GET_SESSION]: z.strictObject({ sessionId: IdSchema }),
  [RESEARCH_CHANNELS.LIST_SESSIONS]: z.strictObject({ scope: ScopeSchema, cursor: IdSchema.optional(), pageSize: z.number().int().min(1).max(200).default(50) }),
  [RESEARCH_CHANNELS.SEARCH]: z.strictObject({ sessionId: IdSchema, query: z.string().trim().min(1).max(1000), cursor: z.string().max(2000).optional(), pageSize: z.number().int().min(1).max(50).default(25) }),
  [RESEARCH_CHANNELS.GET_SNAPSHOT]: z.strictObject({ snapshotId: IdSchema }),
  [RESEARCH_CHANNELS.SELECT_SOURCE]: z.strictObject({ sessionId: IdSchema, candidateId: IdSchema, expectedRevision: RevisionSchema }),
  [RESEARCH_CHANNELS.GET_SOURCE]: z.strictObject({ sourceId: IdSchema }),
  [RESEARCH_CHANNELS.READ_SOURCE_TEXT]: z.strictObject({ sessionId: IdSchema, sourceId: IdSchema }),
  [RESEARCH_CHANNELS.IMPORT_MATERIAL_PDF]: z.strictObject({ sessionId: IdSchema, expectedRevision: RevisionSchema, rootId: IdSchema,
    relativeDir: z.string().max(4096).default(''), generation: GenerationSchema, fileId: IdSchema }),
  [RESEARCH_CHANNELS.SAVE_EVIDENCE]: SaveEvidenceRequestSchema,
  [RESEARCH_CHANNELS.SAVE_REPORT]: SaveReportRequestSchema,
  [RESEARCH_CHANNELS.CREATE_EVIDENCE]: CreateEvidenceRequestSchema,
  [RESEARCH_CHANNELS.CREATE_REPORT]: CreateReportRequestSchema,
  [RESEARCH_CHANNELS.GET_EVIDENCE]: z.strictObject({ revisionId: IdSchema }),
  [RESEARCH_CHANNELS.GET_REPORT]: z.strictObject({ revisionId: IdSchema }),
  [RESEARCH_CHANNELS.EXPORT_EVIDENCE]: z.strictObject({ revisionId: IdSchema }),
  [RESEARCH_CHANNELS.EXPORT_REPORT]: z.strictObject({ revisionId: IdSchema }),
  [RESEARCH_CHANNELS.LIST_ARTIFACTS]: z.strictObject({ sessionId: IdSchema, pageSize: z.number().int().min(1).max(200).default(100), cursor: z.string().max(256).optional() }),
  [RESEARCH_CHANNELS.REVIEW_ARTIFACT]: z.strictObject({ kind: z.enum(['evidence', 'report']), revisionId: IdSchema, expectedRevision: RevisionSchema, decision: z.enum(['confirmed', 'needs-changes']) }),
  [RESEARCH_CHANNELS.CONFIRM_SOURCE_METADATA]: z.strictObject({ sourceId: IdSchema, expectedRevision: RevisionSchema }),
  [RESEARCH_CHANNELS.START_RUN]: StartResearchRunSchema,
  [RESEARCH_CHANNELS.DECIDE_TOOL]: DecideResearchToolSchema,
  [RESEARCH_CHANNELS.CANCEL_RUN]: z.strictObject({ runId: IdSchema, expectedGeneration: GenerationSchema }),
  [RESEARCH_CHANNELS.GET_RUN]: z.strictObject({ runId: IdSchema }),
  [RESEARCH_CHANNELS.LIST_RUNS]: z.strictObject({ sessionId: IdSchema, pageSize: z.number().int().min(1).max(100).default(20), cursor: IdSchema.optional() }),
} as const;
export type ResearchRequestChannel = keyof typeof ResearchRequestSchemas;
export type ResearchRequest<C extends ResearchRequestChannel> = z.infer<(typeof ResearchRequestSchemas)[C]>;
export function parseCreateSession(input: unknown) { return parseContract(CreateSessionSchema, input); }
export function parseResearchRequest<C extends ResearchRequestChannel>(channel: C, input: unknown): ResearchRequest<C>;
export function parseResearchRequest(channel: string, input: unknown): unknown;
export function parseResearchRequest(channel: string, input: unknown): unknown {
  if (!Object.prototype.hasOwnProperty.call(ResearchRequestSchemas, channel)) throw new ResearchError('BIO_INPUT_INVALID');
  const schema = ResearchRequestSchemas[channel as ResearchRequestChannel];
  return parseContract(schema as z.ZodType<unknown>, input);
}
// Extends the existing typed RPC transport; handlers are registered only after auth integration.
export interface ResearchRpcChannelMap {
  'research:v1:getModelConnectionConfiguration': { args: [ResearchRequest<'research:v1:getModelConnectionConfiguration'>]; result: ResearchConnectionConfiguration };
  'research:v1:listSourceSnapshots': { args: [ResearchRequest<'research:v1:listSourceSnapshots'>]; result: SourceSnapshotPage };
  'research:v1:listArtifactRevisions': { args: [ResearchRequest<'research:v1:listArtifactRevisions'>]; result: ArtifactPage };
  'research:v1:listModelConnections': { args: [ResearchRequest<'research:v1:listModelConnections'>]; result: ResearchConnectionView[] };
  'research:v1:saveModelConnection': { args: [ResearchRequest<'research:v1:saveModelConnection'>]; result: ResearchConnectionView };
  'research:v1:getMaterialImage': { args: [ResearchRequest<'research:v1:getMaterialImage'>]; result: MaterialImageResult };
  'research:v1:listMaterialGrants': { args: [ResearchRequest<'research:v1:listMaterialGrants'>]; result: MaterialGrantView[] };
  'research:v1:registerMaterial': { args: [ResearchRequest<'research:v1:registerMaterial'>]; result: MaterialRoot };
  'research:v1:listMaterials': { args: [ResearchRequest<'research:v1:listMaterials'>]; result: { items: MaterialRoot[]; nextCursor?: string } };
  'research:v1:getMaterial': { args: [ResearchRequest<'research:v1:getMaterial'>]; result: MaterialRoot };
  'research:v1:indexMaterialDirectory': { args: [ResearchRequest<'research:v1:indexMaterialDirectory'>]; result: { rootId: string; generation: number } };
  'research:v1:listMaterialDirectory': { args: [ResearchRequest<'research:v1:listMaterialDirectory'>]; result: MaterialPage };
  'research:v1:searchMaterialText': { args: [ResearchRequest<'research:v1:searchMaterialText'>]; result: MaterialSearchResult };
  'research:v1:getMaterialIndex': { args: [ResearchRequest<'research:v1:getMaterialIndex'>]; result: MaterialDirectoryState };
  'research:v1:getMaterialAnnotation': { args: [ResearchRequest<'research:v1:getMaterialAnnotation'>]; result: MaterialAnnotation };
  'research:v1:saveMaterialAnnotation': { args: [ResearchRequest<'research:v1:saveMaterialAnnotation'>]; result: MaterialAnnotation };
  'research:v1:listSpaces': { args: [ResearchRequest<'research:v1:listSpaces'>]; result: ResearchSpaceView[] };
  'research:v1:readAudit': { args: [ResearchRequest<'research:v1:readAudit'>]; result: ResearchAuditEntry[] };
  'research:v1:createProject': { args: [ResearchRequest<'research:v1:createProject'>]; result: { id: string; name: string; revision: number } };
  'research:v1:listMembers': { args: [ResearchRequest<'research:v1:listMembers'>]; result: ResearchMemberView[] };
  'research:v1:inviteMember': { args: [ResearchRequest<'research:v1:inviteMember'>]; result: { revision: number } };
  'research:v1:setMember': { args: [ResearchRequest<'research:v1:setMember'>]; result: { revision: number } };
  'research:v1:createSession': { args: [ResearchRequest<'research:v1:createSession'>]; result: ResearchSession };
  'research:v1:getSession': { args: [ResearchRequest<'research:v1:getSession'>]; result: ResearchSession };
  'research:v1:listSessions': { args: [ResearchRequest<'research:v1:listSessions'>]; result: { items: ResearchSession[]; nextCursor?: string } };
  'research:v1:search': { args: [ResearchRequest<'research:v1:search'>]; result: LiteratureSearchPage };
  'research:v1:selectSource': { args: [ResearchRequest<'research:v1:selectSource'>]; result: LiteratureSelection };
  'research:v1:getSource': { args: [ResearchRequest<'research:v1:getSource'>]; result: ResearchSource };
  'research:v1:readSourceText': { args: [ResearchRequest<'research:v1:readSourceText'>]; result: DocumentIngestResult };
  'research:v1:importMaterialPdf': { args: [ResearchRequest<'research:v1:importMaterialPdf'>]; result: DocumentIngestResult };
  'research:v1:createEvidence': { args: [ResearchRequest<'research:v1:createEvidence'>]; result: EvidenceRevision };
  'research:v1:createReport': { args: [ResearchRequest<'research:v1:createReport'>]; result: ReportRevision };
  'research:v1:getEvidence': { args: [ResearchRequest<'research:v1:getEvidence'>]; result: EvidenceView };
  'research:v1:getReport': { args: [ResearchRequest<'research:v1:getReport'>]; result: ReportView };
  'research:v1:listArtifacts': { args: [ResearchRequest<'research:v1:listArtifacts'>]; result: ArtifactPage };
  'research:v1:reviewArtifact': { args: [ResearchRequest<'research:v1:reviewArtifact'>]; result: EvidenceRevision | ReportRevision };
  'research:v1:confirmSourceMetadata': { args: [ResearchRequest<'research:v1:confirmSourceMetadata'>]; result: ResearchSource };
  'research:v1:exportEvidence': { args: [ResearchRequest<'research:v1:exportEvidence'>]; result: ArtifactExport };
  'research:v1:exportReport': { args: [ResearchRequest<'research:v1:exportReport'>]; result: ArtifactExport };
  'research:v1:getSnapshot': { args: [ResearchRequest<'research:v1:getSnapshot'>]; result: ReadingSnapshot };
  'research:v1:saveEvidence': { args: [ResearchRequest<'research:v1:saveEvidence'>]; result: EvidenceRevision };
  'research:v1:saveReport': { args: [ResearchRequest<'research:v1:saveReport'>]; result: ReportRevision };
  'research:v1:startRun': { args: [ResearchRequest<'research:v1:startRun'>]; result: ResearchRunView };
  'research:v1:decideTool': { args: [ResearchRequest<'research:v1:decideTool'>]; result: { runId: string; requestId: string; decision: 'approve' | 'deny' } };
  'research:v1:cancelRun': { args: [ResearchRequest<'research:v1:cancelRun'>]; result: ResearchRunView };
  'research:v1:getRun': { args: [ResearchRequest<'research:v1:getRun'>]; result: ResearchRunView };
  'research:v1:listRuns': { args: [ResearchRequest<'research:v1:listRuns'>]; result: { items: ResearchRun[]; nextCursor?: string } };
  'research:v1:event': { args: [ResearchEvent]; result: void };
}
export const ResearchEventSchema = z.strictObject({
  version: z.literal(RESEARCH_PROTOCOL_VERSION), id: IdSchema, sequence: RevisionSchema,
  scope: ScopeSchema, sessionId: IdSchema, resourceId: IdSchema, revision: RevisionSchema,
  kind: z.enum(['session-changed', 'run-changed', 'evidence-changed', 'report-changed', 'access-revoked']),
});
export type ResearchEvent = z.infer<typeof ResearchEventSchema>;
export type ResearchScopeRef = ResearchScope;
