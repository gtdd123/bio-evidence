import { z } from 'zod';
import { IdSchema, IdListSchema, ScopeSchema, RevisionSchema, GenerationSchema, CitationSchema,
  parseContract, ResearchError, type ResearchScope, type ResearchSession, type ReadingSnapshot,
  type EvidenceRevision, type ReportRevision, type ResearchRun, type ResearchSource } from './contracts.ts';
import { ReportClaimSchema, ReportTitleSchema, nonBlankText } from './contracts.ts';

export const RESEARCH_PROTOCOL_VERSION = 1 as const;
export const RESEARCH_CHANNELS = {
  CREATE_SESSION: 'research:v1:createSession', GET_SESSION: 'research:v1:getSession',
  LIST_SESSIONS: 'research:v1:listSessions', SEARCH: 'research:v1:search',
  GET_SNAPSHOT: 'research:v1:getSnapshot', SAVE_EVIDENCE: 'research:v1:saveEvidence',
  SAVE_REPORT: 'research:v1:saveReport', START_RUN: 'research:v1:startRun',
  CANCEL_RUN: 'research:v1:cancelRun', GET_RUN: 'research:v1:getRun',
  EVENT: 'research:v1:event',
} as const;
export const CreateSessionSchema = z.strictObject({ scope: ScopeSchema, name: z.string().trim().min(1).max(300), sourceIds: IdListSchema.default([]) });
export const ResearchRequestSchemas = {
  [RESEARCH_CHANNELS.CREATE_SESSION]: CreateSessionSchema,
  [RESEARCH_CHANNELS.GET_SESSION]: z.strictObject({ sessionId: IdSchema }),
  [RESEARCH_CHANNELS.LIST_SESSIONS]: z.strictObject({ scope: ScopeSchema, cursor: IdSchema.optional(), pageSize: z.number().int().min(1).max(200).default(50) }),
  [RESEARCH_CHANNELS.SEARCH]: z.strictObject({ sessionId: IdSchema, query: z.string().trim().min(1).max(1000), cursor: z.string().max(2000).optional(), pageSize: z.number().int().min(1).max(50).default(25) }),
  [RESEARCH_CHANNELS.GET_SNAPSHOT]: z.strictObject({ snapshotId: IdSchema }),
  [RESEARCH_CHANNELS.SAVE_EVIDENCE]: z.strictObject({ evidenceId: IdSchema, expectedRevision: RevisionSchema, claim: nonBlankText(20000), citations: z.array(CitationSchema).min(1).max(100) }),
  [RESEARCH_CHANNELS.SAVE_REPORT]: z.strictObject({ reportId: IdSchema, expectedRevision: RevisionSchema, title: ReportTitleSchema, markdown: z.string().max(1000000), evidenceRevisionIds: IdListSchema, claims: z.array(ReportClaimSchema).max(1000).default([]) }),
  [RESEARCH_CHANNELS.START_RUN]: z.strictObject({ sessionId: IdSchema, expectedRevision: RevisionSchema, connectionId: IdSchema, sourceIds: IdListSchema, question: z.string().trim().min(1).max(20000), operationId: IdSchema }),
  [RESEARCH_CHANNELS.CANCEL_RUN]: z.strictObject({ runId: IdSchema, expectedGeneration: GenerationSchema }),
  [RESEARCH_CHANNELS.GET_RUN]: z.strictObject({ runId: IdSchema }),
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
  'research:v1:createSession': { args: [ResearchRequest<'research:v1:createSession'>]; result: ResearchSession };
  'research:v1:getSession': { args: [ResearchRequest<'research:v1:getSession'>]; result: ResearchSession };
  'research:v1:listSessions': { args: [ResearchRequest<'research:v1:listSessions'>]; result: { items: ResearchSession[]; nextCursor?: string } };
  'research:v1:search': { args: [ResearchRequest<'research:v1:search'>]; result: { items: ResearchSource[]; nextCursor?: string } };
  'research:v1:getSnapshot': { args: [ResearchRequest<'research:v1:getSnapshot'>]; result: ReadingSnapshot };
  'research:v1:saveEvidence': { args: [ResearchRequest<'research:v1:saveEvidence'>]; result: EvidenceRevision };
  'research:v1:saveReport': { args: [ResearchRequest<'research:v1:saveReport'>]; result: ReportRevision };
  'research:v1:startRun': { args: [ResearchRequest<'research:v1:startRun'>]; result: ResearchRun };
  'research:v1:cancelRun': { args: [ResearchRequest<'research:v1:cancelRun'>]; result: ResearchRun };
  'research:v1:getRun': { args: [ResearchRequest<'research:v1:getRun'>]; result: ResearchRun };
  'research:v1:event': { args: [ResearchEvent]; result: void };
}
export const ResearchEventSchema = z.strictObject({
  version: z.literal(RESEARCH_PROTOCOL_VERSION), id: IdSchema, sequence: RevisionSchema,
  scope: ScopeSchema, sessionId: IdSchema, resourceId: IdSchema, revision: RevisionSchema,
  kind: z.enum(['session-changed', 'run-changed', 'evidence-changed', 'report-changed', 'access-revoked']),
});
export type ResearchEvent = z.infer<typeof ResearchEventSchema>;
export type ResearchScopeRef = ResearchScope;
