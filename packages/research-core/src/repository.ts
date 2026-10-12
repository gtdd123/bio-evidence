import type { Actor, ResearchScope, ResearchSource, ReadingSnapshot, EvidenceRevision, ReportRevision, ResearchSession, ResearchRun, RunState } from './contracts.ts';
export type ResearchEntityKind = 'source' | 'snapshot' | 'evidence' | 'report' | 'session' | 'run';
export type ResearchEntity = ResearchSource | ReadingSnapshot | EvidenceRevision | ReportRevision | ResearchSession | ResearchRun;
export interface AuthorityUser { id: string; username: string; passwordHash: string; active: boolean; administrator: boolean; revision: number }
export interface AuthorityAuthSession { id: string; userId: string; tokenHash: string; expiresAt: number }
export interface PublicAccount { id: string; username: string; administrator: boolean }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ProjectionEntry { sequence: number; sessionId: string; operationId: string; generation: number; hash: string; messages: JsonValue[]; projected: boolean;
  format: 'legacy-runtime' | 'stored-snapshot'; header?: { [key: string]: JsonValue } }
export interface ResearchRepository {
  seedUser(user: AuthorityUser): void;
  getUserForAuth(username: string): AuthorityUser | null;
  createAuthorityAccount(actor: Actor | null, user: AuthorityUser): void;
  issueAuthSession(session: AuthorityAuthSession, expectedUserRevision: number): void;
  findAuthenticatedActor(tokenHash: string, now: number): Actor | null;
  resolveAuthenticatedActor(sessionId: string, now: number): Actor | null;
  revokeAuthSession(actor: Actor): void;
  setAccountActive(actor: Actor, userId: string, active: boolean, expectedRevision: number): void;
  currentAccount(actor: Actor): PublicAccount;
  recordAuthFailure(action?: 'login' | 'account-create' | 'account-status', actorId?: string): void;
  createProject(actor: Actor, id: string, name: string): { id: string; name: string; revision: number };
  setMember(actor: Actor, projectId: string, userId: string, role: 'owner' | 'editor' | 'viewer', active: boolean, expectedRevision: number): { revision: number };
  put(actor: Actor, kind: ResearchEntityKind, input: unknown, expectedRevision?: number): ResearchEntity;
  get(actor: Actor, kind: ResearchEntityKind, id: string): ResearchEntity;
  reviewRevision(actor: Actor, kind: 'evidence' | 'report', id: string, expectedRevision: number, decision: 'confirmed' | 'needs-changes', now: number): EvidenceRevision | ReportRevision;
  advanceRun(actor: Actor, id: string, next: RunState, expectedGeneration: number, workerId: string | null, now: number, leaseExpiresAt?: number): ResearchRun;
  appendProjection(actor: Actor, sessionId: string, operationId: string, messages: JsonValue[], generation: number): number;
  appendProjectionSnapshot(actor: Actor, sessionId: string, operationId: string, header: { [key: string]: JsonValue }, messages: JsonValue[], generation: number): number;
  markProjected(actor: Actor, sessionId: string, operationId: string, generation: number, hash: string): void;
  readProjection(actor: Actor, sessionId: string, forWrite?: boolean): ProjectionEntry[];
  readAudit(actor: Actor, scope: ResearchScope): Array<{ action: string; outcome: string; resourceId: string | null }>;
  close(): void;
}
export interface ResearchServiceContext { readonly repository: ResearchRepository }
export function createResearchServiceContext(repository: ResearchRepository): ResearchServiceContext { return Object.freeze({ repository }); }
