// Research contract added to the existing transport. No handlers or data stores here.
export { ResearchRunStateAdapter, type ResearchRunClientState } from './research-run-state';
export {
  RESEARCH_PROTOCOL_VERSION, RESEARCH_CHANNELS, ResearchRequestSchemas,
  parseResearchRequest, ResearchEventSchema, ResearchError,
} from '@bio-evidence/research-core';
export type {
  Actor, ResearchScope, DataPolicy, ResearchSession, ResearchSource, ReadingSnapshot, TextBlock,
  EvidenceRevision, ReportRevision, Citation, ResearchRun, RunState, ResearchEvent,
  ArticleLicense, RunLease,
  ResearchRunView, StartResearchRun,
  ResearchSpaceView, ResearchMemberView, ResearchAuditEntry,
  MaterialGrantView, MaterialRoot, MaterialEntry, MaterialPage, MaterialSearchResult, MaterialDirectoryState, MaterialAnnotation, MaterialImageResult,
  ResearchRequestChannel, ResearchRequest, ResearchRpcChannelMap, BioErrorCode,
} from '@bio-evidence/research-core';
