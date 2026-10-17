// Bun-only adapter. Do not export it from server-core's Node/Electron entry.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import { mkdirSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  ActorSchema, ScopeSchema, IdSchema, GenerationSchema, RevisionSchema, SourceSchema, SnapshotSchema,
  EvidenceRevisionSchema, ReportRevisionSchema, SessionSchema, RunSchema, ResearchError, BIO_ERROR_MESSAGES,
  parseContract, assertScopeAccess, assertSessionControl, sameScope, assertSnapshotSource, validateCitation,
  mergeSessionPolicy, transitionRun, RunStateSchema,
  type Actor, type ResearchScope, type ResearchEntity, type ResearchEntityKind,
  type ResearchRepository, type AuthorityUser, type JsonValue, type ProjectionEntry, type ResearchRun, type RunState,
  type EvidenceRevision, type ReportRevision, type AuthorityAuthSession, type ResearchEvent,
  DeploymentGrantSchema, MaterialRootSchema, MaterialDirectoryStateSchema, IndexedMaterialEntrySchema, MaterialAnnotationSchema,
  type StoredDeploymentGrant, type MaterialRoot, type MaterialDirectoryState, type IndexedMaterialEntry, type MaterialAnnotation,
  ArtifactPageSchema, SourceSnapshotPageSchema,
  ResearchConnectionRecordSchema, type ResearchConnectionRecord,
  StartResearchRunSchema, PublicInputManifestSchema, ResearchRunViewSchema, type ResearchRunView,
  PublicModelInputSchema, PublicCandidateResultSchema, type PublicCandidateResult,
} from '@bio-evidence/research-core';
import type { PreparedPublicInput } from './public-input.ts';
import { resolveConfigDir, validateNamespacePath } from '@craft-agent/shared/config/namespace';
import { INITIAL_SCHEMA, SCHEMA_VERSION } from './schema.ts';

const Schemas = { source: SourceSchema, snapshot: SnapshotSchema, evidence: EvidenceRevisionSchema,
  report: ReportRevisionSchema, session: SessionSchema, run: RunSchema, connection: ResearchConnectionRecordSchema } as const;
const KindSchema = z.enum(['source', 'snapshot', 'evidence', 'report', 'session', 'run', 'connection']);
const UserSchema = z.strictObject({ id: IdSchema, username: z.string().min(1).max(128), passwordHash: z.string().min(1).max(4096),
  active: z.boolean(), administrator: z.boolean(), revision: z.literal(1) });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const scopeKey = (scope: ResearchScope) => scope.kind === 'personal' ? `personal:${scope.ownerId}` : `project:${scope.projectId}`;
type UserRow = { id: string; username: string; password_hash: string; active: number; administrator: number; revision: number };
type HeadRow = { revision: number; record_id: string; policy: string | null };

export class SqliteResearchRepository implements ResearchRepository {
  private db!: Database;
  private statements = new Set<{ finalize(): void }>();
  private readonly instanceId = randomUUID();
  private closed = false;
  private query<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string) {
    const database = this.db;
    const statement = database.query<Row, Params>(sql);
    this.statements.add(statement);
    return statement;
  }
  constructor(filename = ':memory:') {
    try {
      if (filename !== ':memory:') {
        filename = validateNamespacePath(resolve(filename));
        const root = resolveConfigDir();
        mkdirSync(root, { recursive: true });
        const realRoot = realpathSync.native(root);
        let ancestor = dirname(filename);
        while (!existsSync(ancestor)) ancestor = dirname(ancestor);
        const offset = relative(realRoot, realpathSync.native(ancestor));
        if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
        mkdirSync(dirname(filename), { recursive: true });
        if (existsSync(filename)) {
          const target = relative(realRoot, realpathSync.native(filename));
          if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
          filename = realpathSync.native(filename);
        }
      }
      this.db = new Database(filename, { create: true, strict: true });
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      const version = this.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
      if (version > SCHEMA_VERSION) throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
      if (version === 0) {
        const existing = this.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (existing.length) throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
        if (filename !== ':memory:') writeFileSync(`${filename}.backup-v0-${randomUUID()}`, this.db.serialize(), { flag: 'wx', mode: 0o600 });
        this.db.transaction(() => this.db.exec(INITIAL_SCHEMA)).immediate();
      }
      this.db.transaction(() => {
        const old = this.query<{ owner_nonce: string | null; owner_pid: number | null }, []>('SELECT owner_nonce,owner_pid FROM service_instance WHERE singleton=1').get();
        if (old?.owner_nonce && old.owner_pid) {
          let alive = true;
          try { process.kill(old.owner_pid, 0); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
          }
          if (alive) throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
        }
        this.query('INSERT INTO service_instance VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET owner_nonce=excluded.owner_nonce,owner_pid=excluded.owner_pid')
          .run(this.instanceId, process.pid);
      }).immediate();
    } catch {
      this.close();
      throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { if (this.db) this.query('UPDATE service_instance SET owner_nonce=NULL,owner_pid=NULL WHERE singleton=1 AND owner_nonce=?').run(this.instanceId); }
    catch { /* cannot release an unknown or unavailable store */ }
    finally {
      for (const statement of this.statements) statement.finalize();
      this.statements.clear();
      this.db?.close(true);
    }
  }
  private assertWriter() {
    const row = this.query<{ owner_nonce: string | null }, []>('SELECT owner_nonce FROM service_instance WHERE singleton=1').get();
    if (this.closed || row?.owner_nonce !== this.instanceId) throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
  }
  private audit(actorId: string, scope: ResearchScope | null, action: string, outcome: 'success' | 'denied' | 'failed', resourceId: string | null) {
    this.query('INSERT INTO audit(actor_id,scope_key,action,outcome,resource_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(actorId, scope ? scopeKey(scope) : null, action, outcome, resourceId, Date.now());
  }
  private event(scope: ResearchScope, kind: string, id: string, revision: number) {
    this.query('INSERT INTO outbox(scope_key,kind,resource_id,revision,created_at) VALUES(?,?,?,?,?)').run(scopeKey(scope), kind, id, revision, Date.now());
  }
  private currentActor(input: Actor): Actor {
    const user = this.query<Pick<UserRow, 'active' | 'administrator'>, [string]>('SELECT active,administrator FROM users WHERE id=?').get(input.userId);
    if (!user?.active || !input.active) throw new ResearchError('BIO_ACCESS_DENIED');
    return { ...input, active: true, administrator: user.administrator === 1 };
  }
  private tx<T>(input: Actor, scope: ResearchScope | null, action: string, id: string | null, work: (actor: Actor) => T, outcome: 'success' | 'failed' = 'success'): T {
    const actor = parseContract(ActorSchema, input);
    try {
      return this.db.transaction(() => {
        this.assertWriter();
        const result = work(this.currentActor(actor));
        this.audit(actor.userId, scope, action, outcome, id);
        return result;
      }).immediate();
    } catch (error) {
      try { this.audit(actor.userId, scope, action, error instanceof ResearchError && error.code === 'BIO_ACCESS_DENIED' ? 'denied' : 'failed', id); }
      catch { throw new ResearchError('BIO_STORAGE_UNAVAILABLE'); }
      if (error instanceof ResearchError) throw error;
      throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
    }
  }
  private authorize(actor: Actor, scope: ResearchScope, action: 'read' | 'write' | 'manage') {
    const member = scope.kind === 'project' ? this.query<{ role: 'owner' | 'editor' | 'viewer'; active: number }, [string, string]>(
      'SELECT role,active FROM members WHERE project_id=? AND user_id=?',
    ).get(scope.projectId, actor.userId) : null;
    assertScopeAccess(this.currentActor(actor), scope, member && scope.kind === 'project' ? {
      projectId: scope.projectId, userId: actor.userId, role: member.role, active: member.active === 1,
    } : null, action);
  }
  private binding(kind: string, id: string): ResearchScope {
    const row = this.query<{ scope_json: string }, [string, string]>(
      'SELECT s.scope_json FROM bindings b JOIN spaces s ON b.scope_key=s.scope_key WHERE b.kind=? AND b.id=?',
    ).get(kind, id);
    if (!row) throw new ResearchError('BIO_ACCESS_DENIED');
    return parseContract(ScopeSchema, JSON.parse(row.scope_json));
  }
  seedUser(input: AuthorityUser): void {
    const user = parseContract(UserSchema, input);
    this.db.transaction(() => {
      this.assertWriter();
      this.query('INSERT INTO users VALUES(?,?,?,?,?,?)').run(user.id, user.username, user.passwordHash, Number(user.active), Number(user.administrator), 1);
      const scope: ResearchScope = { kind: 'personal', ownerId: user.id };
      this.query('INSERT INTO spaces VALUES(?,?,?)').run(scopeKey(scope), JSON.stringify(scope), user.id);
    }).immediate();
  }
  getUserForAuth(username: string): AuthorityUser | null {
    const user = this.query<UserRow, [string]>('SELECT * FROM users WHERE username=?').get(username);
    return user ? { id: user.id, username: user.username, passwordHash: user.password_hash, active: user.active === 1,
      administrator: user.administrator === 1, revision: user.revision } : null;
  }
  createAuthorityAccount(actor: Actor | null, input: AuthorityUser): void {
    const user = parseContract(UserSchema, input);
    const insert = () => this.seedUser(user);
    if (actor) {
      this.tx(actor, null, 'account-create', user.id, current => {
        if (!current.administrator) throw new ResearchError('BIO_ACCESS_DENIED');
        insert();
      });
    } else {
      // This is a local bootstrap capability, never an HTTP signup route.
      try {
        this.db.transaction(() => {
          this.assertWriter();
          if (!user.administrator || this.query<{ count: number }, []>('SELECT count(*) AS count FROM users').get()!.count !== 0) {
            throw new ResearchError('BIO_ACCESS_DENIED');
          }
          insert(); this.audit(user.id, null, 'account-bootstrap', 'success', user.id);
        }).immediate();
      } catch (error) {
        this.audit('bootstrap', null, 'account-bootstrap', error instanceof ResearchError ? 'denied' : 'failed', user.id);
        if (error instanceof ResearchError) throw error; throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
      }
    }
  }
  issueAuthSession(input: AuthorityAuthSession, expectedUserRevision: number): void {
    const session = parseContract(z.strictObject({ id: IdSchema, userId: IdSchema, tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: GenerationSchema }), input);
    parseContract(GenerationSchema, expectedUserRevision);
    try {
      this.db.transaction(() => {
        this.assertWriter();
        const user = this.query<{ active: number; revision: number }, [string]>('SELECT active,revision FROM users WHERE id=?').get(session.userId);
        if (!user?.active || user.revision !== expectedUserRevision) throw new ResearchError('BIO_ACCESS_DENIED');
        this.query('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)')
          .run(session.id, session.userId, session.tokenHash, session.expiresAt);
        this.audit(session.userId, null, 'login', 'success', session.id);
      }).immediate();
    } catch (error) {
      this.audit(session.userId, null, 'login', error instanceof ResearchError ? 'denied' : 'failed', session.id);
      if (error instanceof ResearchError) throw error; throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
    }
  }
  private authenticatedActor(key: 'id' | 'token_hash', value: string, now: number): Actor | null {
    const row = this.query<{ id: string; user_id: string; administrator: number }, [string, number]>(
      `SELECT a.id,a.user_id,u.administrator FROM auth_sessions a JOIN users u ON u.id=a.user_id
       WHERE a.${key}=? AND a.revoked=0 AND a.expires_at>? AND u.active=1`,
    ).get(value, now);
    return row ? Object.freeze({ userId: row.user_id, authSessionId: row.id, active: true, administrator: row.administrator === 1 }) : null;
  }
  findAuthenticatedActor(tokenHash: string, now: number): Actor | null {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null;
    return this.authenticatedActor('token_hash', tokenHash, parseContract(GenerationSchema, now));
  }
  resolveAuthenticatedActor(sessionId: string, now: number): Actor | null {
    if (!IdSchema.safeParse(sessionId).success) return null;
    return this.authenticatedActor('id', sessionId, parseContract(GenerationSchema, now));
  }
  revokeAuthSession(actor: Actor): void {
    this.tx(actor, null, 'logout', actor.authSessionId, current => {
      const result = this.query('UPDATE auth_sessions SET revoked=1 WHERE id=? AND user_id=?')
        .run(current.authSessionId, current.userId);
      if (result.changes !== 1) throw new ResearchError('BIO_ACCESS_DENIED');
    });
  }
  setAccountActive(actor: Actor, userId: string, active: boolean, expectedRevision: number): void {
    parseContract(IdSchema, userId); parseContract(z.boolean(), active); parseContract(GenerationSchema, expectedRevision);
    this.tx(actor, null, 'account-status', userId, current => {
      if (!current.administrator) throw new ResearchError('BIO_ACCESS_DENIED');
      const user = this.query<{ administrator: number; active: number; revision: number }, [string]>(
        'SELECT administrator,active,revision FROM users WHERE id=?',
      ).get(userId);
      if (!user || user.revision !== expectedRevision) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (!active && user.active && user.administrator && this.query<{ count: number }, []>(
        'SELECT count(*) AS count FROM users WHERE active=1 AND administrator=1',
      ).get()!.count <= 1) throw new ResearchError('BIO_ACCESS_DENIED');
      this.query('UPDATE users SET active=?,revision=revision+1 WHERE id=? AND revision=?').run(Number(active), userId, expectedRevision);
      if (!active) this.query('UPDATE auth_sessions SET revoked=1 WHERE user_id=?').run(userId);
    });
  }
  currentAccount(actor: Actor) {
    const current = this.currentActor(actor);
    const user = this.query<{ id: string; username: string }, [string]>('SELECT id,username FROM users WHERE id=?').get(current.userId)!;
    return { id: user.id, username: user.username, administrator: current.administrator };
  }
  recordAuthFailure(action: 'login' | 'account-create' | 'account-status' = 'login', actorId = 'authentication'): void {
    this.assertWriter(); parseContract(z.enum(['login', 'account-create', 'account-status']), action); parseContract(IdSchema, actorId);
    this.audit(actorId, null, action, 'denied', null);
  }
  authorizeScope(actor: Actor, input: ResearchScope, action: 'read' | 'write' | 'manage'): void {
    const scope = parseContract(ScopeSchema, input);
    parseContract(z.enum(['read', 'write', 'manage']), action);
    this.tx(actor, scope, `scope-${action}`, null, current => this.authorize(current, scope, action));
  }
  authorizeResource(actor: Actor, kindInput: ResearchEntityKind, idInput: string, action: 'read' | 'write' | 'execute' | 'cancel') {
    const kind = parseContract(KindSchema, kindInput), requestedId = parseContract(IdSchema, idInput);
    parseContract(z.enum(['read', 'write', 'execute', 'cancel']), action);
    const head = kind === 'evidence' || kind === 'report' ? this.query<{ record_id: string }, [string, string]>(
      'SELECT record_id FROM heads WHERE kind=? AND entity_id=?',
    ).get(kind, requestedId) : null;
    const id = head?.record_id ?? requestedId;
    let scope: ResearchScope;
    try { scope = this.binding(kind, id) } catch {
      // No known binding means no owner audit scope. Do not place a guessed
      // private identifier into the global account/service audit.
      return this.tx(actor, null, `resource-${action}`, null, () => { throw new ResearchError('BIO_ACCESS_DENIED') });
    }
    return this.tx(actor, scope, `resource-${action}`, requestedId, current => {
      this.authorize(current, scope, action === 'read' || action === 'cancel' ? 'read' : 'write');
      // Resolve only authority metadata before reading any payload body.
      const metadata = this.query<{ owner_id: string | null; session_id: string | null }, [string, string]>(
        "SELECT json_extract(payload,'$.ownerId') AS owner_id,json_extract(payload,'$.sessionId') AS session_id FROM entities WHERE kind=? AND id=?",
      ).get(kind, id);
      if (!metadata) throw new ResearchError('BIO_ACCESS_DENIED');
      let ownerId = metadata.owner_id ?? undefined, sessionId = metadata.session_id ?? undefined;
      if (kind === 'run') {
        if (!sessionId || !sameScope(this.binding('session', sessionId), scope)) throw new ResearchError('BIO_ACCESS_DENIED');
        const session = this.query<{ owner_id: string }, [string]>(
          "SELECT json_extract(payload,'$.ownerId') AS owner_id FROM entities WHERE kind='session' AND id=?",
        ).get(sessionId);
        ownerId = session?.owner_id;
      }
      if (action === 'execute' || action === 'cancel') {
        if (!['session', 'run'].includes(kind) || ownerId !== current.userId) throw new ResearchError('BIO_ACCESS_DENIED');
      }
      return { id, scope, ...(ownerId ? { ownerId } : {}), ...(sessionId ? { sessionId } : {}) };
    });
  }
  listSpaces(actor: Actor) {
    return this.tx(actor, null, 'spaces-list', null, current => {
      const projects = this.query<{ id: string; name: string; revision: number; role: 'owner' | 'editor' | 'viewer' }, [string]>(
        'SELECT p.id,p.name,p.revision,m.role FROM projects p JOIN members m ON p.id=m.project_id WHERE m.user_id=? AND m.active=1 ORDER BY p.id',
      ).all(current.userId);
      return [{ scope: { kind: 'personal' as const, ownerId: current.userId }, name: 'Personal', role: 'owner' as const, revision: 1 },
        ...projects.map(project => ({ scope: { kind: 'project' as const, projectId: project.id }, name: project.name, role: project.role, revision: project.revision }))];
    });
  }
  listMembers(actor: Actor, projectId: string) {
    parseContract(IdSchema, projectId);
    const scope: ResearchScope = { kind: 'project', projectId };
    return this.tx(actor, scope, 'members-list', projectId, current => {
      this.authorize(current, scope, 'read');
      return this.query<{ user_id: string; username: string; role: 'owner' | 'editor' | 'viewer'; active: number }, [string]>(
        'SELECT m.user_id,u.username,m.role,m.active FROM members m JOIN users u ON m.user_id=u.id WHERE m.project_id=? ORDER BY m.user_id',
      ).all(projectId).map(member => ({ userId: member.user_id, username: member.username, role: member.role, active: member.active === 1 }));
    });
  }
  inviteMember(actor: Actor, projectId: string, username: string, role: 'owner' | 'editor' | 'viewer', expectedRevision: number) {
    parseContract(IdSchema, projectId); parseContract(z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/), username);
    const scope: ResearchScope = { kind: 'project', projectId };
    return this.tx(actor, scope, 'member-invite', projectId, current => {
      this.authorize(current, scope, 'manage');
      const target = this.query<{ id: string }, [string]>('SELECT id FROM users WHERE username=? AND active=1').get(username);
      if (!target) throw new ResearchError('BIO_ACCESS_DENIED');
      return this.setMember(current, projectId, target.id, role, true, expectedRevision);
    });
  }
  listSessions(actor: Actor, input: ResearchScope, pageSize: number, cursor?: string) {
    const scope = parseContract(ScopeSchema, input);
    parseContract(z.number().int().min(1).max(200), pageSize); if (cursor) parseContract(IdSchema, cursor);
    return this.tx(actor, scope, 'sessions-list', null, current => {
      this.authorize(current, scope, 'read');
      const rows = this.query<{ id: string }, [string, string, number]>(
        "SELECT id FROM bindings WHERE kind='session' AND scope_key=? AND id>? ORDER BY id LIMIT ?",
      ).all(scopeKey(scope), cursor ?? '', pageSize + 1);
      const items = rows.slice(0, pageSize).map(row => parseContract(SessionSchema, this.get(current, 'session', row.id)));
      return { items, ...(rows.length > pageSize ? { nextCursor: items.at(-1)!.id } : {}) };
    });
  }
  createProject(actor: Actor, idInput: string, nameInput: string) {
    const id = parseContract(IdSchema, idInput);
    const name = parseContract(z.string().min(1).max(300), nameInput);
    const scope: ResearchScope = { kind: 'project', projectId: id };
    return this.tx(actor, scope, 'project-create', id, current => {
      this.query('INSERT INTO projects VALUES(?,?,?,?)').run(id, name, current.userId, 1);
      this.query('INSERT INTO spaces VALUES(?,?,?)').run(scopeKey(scope), JSON.stringify(scope), current.userId);
      this.query('INSERT INTO members VALUES(?,?,?,?)').run(id, current.userId, 'owner', 1);
      this.event(scope, 'project', id, 1);
      return { id, name, revision: 1 };
    });
  }
  setMember(actor: Actor, projectId: string, userId: string, roleInput: 'owner' | 'editor' | 'viewer', active: boolean, expectedRevision: number) {
    parseContract(IdSchema, projectId); parseContract(IdSchema, userId);
    parseContract(GenerationSchema, expectedRevision); parseContract(z.boolean(), active);
    const role = parseContract(z.enum(['owner', 'editor', 'viewer']), roleInput);
    const scope: ResearchScope = { kind: 'project', projectId };
    return this.tx(actor, scope, 'membership-change', projectId, current => {
      this.authorize(current, scope, 'manage');
      const project = this.query<{ owner_id: string; revision: number }, [string]>('SELECT owner_id,revision FROM projects WHERE id=?').get(projectId)!;
      if (project.revision !== expectedRevision) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (project.owner_id === userId && (!active || role !== 'owner')) throw new ResearchError('BIO_ACCESS_DENIED');
      this.query('INSERT INTO members VALUES(?,?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,active=excluded.active')
        .run(projectId, userId, role, Number(active));
      this.query('UPDATE projects SET revision=revision+1 WHERE id=? AND revision=?').run(projectId, expectedRevision);
      this.event(scope, 'membership', projectId, expectedRevision + 1);
      return { revision: expectedRevision + 1 };
    });
  }
  get(input: Actor, kindInput: ResearchEntityKind, idInput: string): ResearchEntity {
    const kind = parseContract(KindSchema, kindInput);
    const id = parseContract(IdSchema, idInput);
    let scope: ResearchScope | null = null;
    try { scope = this.binding(kind, id); } catch {
      return this.tx(input, { kind: 'personal', ownerId: input.userId }, 'resource-read', id, () => { throw new ResearchError('BIO_ACCESS_DENIED'); });
    }
    return this.tx(input, scope, 'resource-read', id, actor => {
      this.authorize(actor, scope!, 'read');
      const row = this.query<{ payload: string }, [string, string]>('SELECT payload FROM entities WHERE kind=? AND id=?').get(kind, id);
      if (!row) throw new ResearchError('BIO_ACCESS_DENIED');
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const review = this.query<{ decision: string; reviewer_id: string; reviewed_at: number; revision: number }, [string, string]>(
        'SELECT * FROM reviews WHERE kind=? AND record_id=?',
      ).get(kind, id);
      if (review && kind === 'source') Object.assign(payload, { metadataReview: { sourceId: id, sourceRevision: review.revision, reviewerId: review.reviewer_id, reviewedAt: review.reviewed_at } });
      else if (review) Object.assign(payload, { reviewStatus: review.decision, review: {
        reviewerId: review.reviewer_id, reviewedAt: review.reviewed_at, revisionId: id, revisionNumber: review.revision,
      } });
      return parseContract(Schemas[kind] as z.ZodType<ResearchEntity>, payload);
    });
  }
  put(actor: Actor, kindInput: ResearchEntityKind, input: unknown, expectedRevision = 0): ResearchEntity {
    const kind = parseContract(KindSchema, kindInput);
    const value = parseContract(Schemas[kind] as z.ZodType<ResearchEntity>, input);
    parseContract(GenerationSchema, expectedRevision);
    return this.tx(actor, value.scope, `${kind}-write`, value.id, current => {
      this.authorize(current, value.scope, 'write');
      if (kind === 'connection') {
        if (!current.administrator) throw new ResearchError('BIO_ACCESS_DENIED');
        const connection = value as ResearchConnectionRecord;
        for (const grant of connection.scopes) if (!this.query('SELECT 1 FROM spaces WHERE scope_key=?').get(scopeKey(grant))) throw new ResearchError('BIO_INPUT_INVALID');
      }
      const entityId = kind === 'evidence' ? (value as z.infer<typeof EvidenceRevisionSchema>).evidenceId :
        kind === 'report' ? (value as z.infer<typeof ReportRevisionSchema>).reportId :
        kind === 'source' ? (value as z.infer<typeof SourceSchema>).sourceIdentityId ?? value.id : value.id;
      const head = this.query<HeadRow, [string, string]>('SELECT revision,record_id,policy FROM heads WHERE kind=? AND entity_id=?').get(kind, entityId);
      if ((head?.revision ?? 0) !== expectedRevision) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (head && !sameScope(this.binding(kind, head.record_id), value.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
      if ('policy' in value && head?.policy && mergeSessionPolicy(head.policy, [value.policy]) !== value.policy) throw new ResearchError('BIO_POLICY_DENIED');
      if ('revision' in value && value.revision !== expectedRevision + 1) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (kind === 'source') {
        const source = value as z.infer<typeof SourceSchema>;
        if (source.metadataReview) throw new ResearchError('BIO_INPUT_INVALID');
        if (source.declaration && source.declaration.actorId !== current.userId) throw new ResearchError('BIO_ACCESS_DENIED');
        if (head && (!source.revision || source.predecessorId !== head.record_id)) throw new ResearchError('BIO_REVISION_CONFLICT');
        if (head) {
          const previous = parseContract(SourceSchema, this.get(current, 'source', head.record_id));
          if (source.createdAt < previous.createdAt) throw new ResearchError('BIO_INPUT_INVALID');
        }
      }
      if (kind === 'snapshot') {
        if (head) throw new ResearchError('BIO_REVISION_CONFLICT');
        const snapshot = value as z.infer<typeof SnapshotSchema>;
        assertSnapshotSource(snapshot, this.get(current, 'source', snapshot.sourceId));
      }
      if (kind === 'session') {
        const session = value as z.infer<typeof SessionSchema>;
        const selected = (session.selectedSourceIds ?? []).map(id => parseContract(SourceSchema, this.get(current, 'source', id)));
        if (selected.some(source => !sameScope(source.scope, session.scope))) throw new ResearchError('BIO_ACCESS_DENIED');
        if (mergeSessionPolicy(session.policy, selected.map(source => source.policy)) !== session.policy) throw new ResearchError('BIO_POLICY_DENIED');
        if (session.ownerId !== current.userId || (head && parseContract(SessionSchema, this.get(current, 'session', head.record_id)).ownerId !== session.ownerId)) {
          throw new ResearchError('BIO_ACCESS_DENIED');
        }
      }
      if (kind === 'run') {
        const run = value as ResearchRun;
        const session = parseContract(SessionSchema, this.get(current, 'session', run.sessionId));
        if (run.actorId !== session.ownerId || current.userId !== session.ownerId || !sameScope(run.scope, session.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
        if (head || run.state !== 'queued') throw new ResearchError('BIO_INVALID_TRANSITION');
      }
      if ((kind === 'evidence' || kind === 'report') && ('reviewStatus' in value && (value.reviewStatus !== 'unreviewed' || 'review' in value && value.review))) {
        throw new ResearchError('BIO_INPUT_INVALID');
      }
      if (kind === 'evidence') {
        const evidence = value as z.infer<typeof EvidenceRevisionSchema>;
        for (const ref of evidence.citations) {
          const snapshot = parseContract(SnapshotSchema, this.get(current, 'snapshot', ref.snapshotId));
          if (!sameScope(snapshot.scope, evidence.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
          if (evidence.policy === 'public' && snapshot.policy !== 'public') throw new ResearchError('BIO_POLICY_DENIED');
          if (evidence.structuralStatus === 'structure-valid' && validateCitation(snapshot, ref).status !== 'structure-valid') throw new ResearchError('BIO_INPUT_INVALID');
        }
      }
      if (kind === 'report') for (const id of (value as z.infer<typeof ReportRevisionSchema>).evidenceRevisionIds) {
        const evidence = parseContract(EvidenceRevisionSchema, this.get(current, 'evidence', id));
        if (!sameScope(evidence.scope, value.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
        if ('policy' in value && value.policy === 'public' && evidence.policy !== 'public') throw new ResearchError('BIO_POLICY_DENIED');
        if ('structuralStatus' in value && value.structuralStatus === 'structure-valid' && evidence.structuralStatus !== 'structure-valid') throw new ResearchError('BIO_INPUT_INVALID');
      }
      if (('review' in value && value.review && value.review.reviewerId !== current.userId) ||
          ('authorId' in value && value.authorId !== current.userId)) throw new ResearchError('BIO_ACCESS_DENIED');
      if ((kind === 'evidence' || kind === 'report') && 'declaration' in value && value.declaration && value.declaration.actorId !== current.userId) throw new ResearchError('BIO_ACCESS_DENIED');
      const oldBinding = this.query<{ scope_key: string }, [string, string]>('SELECT scope_key FROM bindings WHERE kind=? AND id=?').get(kind, value.id);
      if (oldBinding && oldBinding.scope_key !== scopeKey(value.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
      if (oldBinding && ['source', 'snapshot', 'evidence', 'report'].includes(kind)) throw new ResearchError('BIO_REVISION_CONFLICT');
      this.query('INSERT INTO bindings VALUES(?,?,?) ON CONFLICT(kind,id) DO NOTHING').run(kind, value.id, scopeKey(value.scope));
      this.query('INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload')
        .run(kind, value.id, scopeKey(value.scope), JSON.stringify(value));
      this.query('INSERT INTO heads VALUES(?,?,?,?,?) ON CONFLICT(kind,entity_id) DO UPDATE SET record_id=excluded.record_id,revision=excluded.revision,policy=excluded.policy')
        .run(kind, entityId, value.id, expectedRevision + 1, ('policy' in value ? value.policy : null) ?? null);
      if (kind === 'snapshot') for (const block of (value as z.infer<typeof SnapshotSchema>).blocks) {
        this.query('INSERT INTO snapshot_blocks VALUES(?,?,?,?,?)').run(value.id, block.id, block.unit, block.text, JSON.stringify(block.locator));
      }
      if (kind === 'run') {
        this.query('DELETE FROM run_leases WHERE run_id=?').run(value.id);
        const lease = (value as ResearchRun).lease;
        if (lease) this.query('INSERT INTO run_leases VALUES(?,?,?,?)').run(value.id, lease.workerId, lease.generation, lease.expiresAt);
      }
      if (kind !== 'connection') this.event(value.scope, kind, value.id, expectedRevision + 1);
      return value;
    });
  }
  artifactHead(actor: Actor, kind: 'evidence' | 'report', id: string): EvidenceRevision | ReportRevision {
    const authorized = this.authorizeResource(actor, kind, id, 'read');
    return this.get(actor, kind, authorized.id) as EvidenceRevision | ReportRevision;
  }
  managedResearchConnection(actor: Actor, id: string): ResearchConnectionRecord | undefined {
    parseContract(IdSchema, id);
    return this.tx(actor, { kind: 'personal', ownerId: actor.userId }, 'connection-config-read', id, current => {
      if (!current.administrator) throw new ResearchError('BIO_ACCESS_DENIED');
      const row = this.query<{ present: number }, [string]>("SELECT 1 AS present FROM entities WHERE kind='connection' AND id=?").get(id);
      return row ? parseContract(ResearchConnectionRecordSchema, this.get(current, 'connection', id)) : undefined;
    });
  }
  researchConnectionsForScope(actor: Actor, scope: ResearchScope): ResearchConnectionRecord[] {
    this.authorizeScope(actor, scope, 'read');
    const scopeId = scope.kind === 'personal' ? scope.ownerId : scope.projectId;
    const where = `FROM entities e JOIN users u ON u.id=json_extract(e.payload,'$.scope.ownerId') WHERE e.kind='connection' AND u.active=1 AND u.administrator=1 AND EXISTS
      (SELECT 1 FROM json_each(e.payload,'$.scopes') g WHERE json_extract(g.value,'$.kind')=? AND coalesce(json_extract(g.value,'$.ownerId'),json_extract(g.value,'$.projectId'))=?)`;
    const budget = this.query<{ count: number; bytes: number }, [string, string]>(`SELECT count(*) AS count,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes ${where}`).get(scope.kind, scopeId)!;
    if (budget.count > 1000 || budget.bytes > 8 * 1024 * 1024) throw new ResearchError('BIO_CONNECTION_INVALID');
    return this.query<{ payload: string }, [string, string]>(`SELECT payload ${where} ORDER BY e.id LIMIT 1000`).all(scope.kind, scopeId).map(row => parseContract(ResearchConnectionRecordSchema, JSON.parse(row.payload)));
  }
  commitResearchConnection(actor: Actor, record: ResearchConnectionRecord, expectedRevision: number): ResearchConnectionRecord {
    return this.tx(actor, { kind: 'personal', ownerId: actor.userId }, 'connection-save', record.id, current => {
      if (!current.administrator) throw new ResearchError('BIO_ACCESS_DENIED');
      return parseContract(ResearchConnectionRecordSchema, this.put(current, 'connection', record, expectedRevision));
    });
  }
  recordConnectionSaveFailure(actor: Actor, id: string): void {
    parseContract(IdSchema, id);
    this.tx(actor, { kind: 'personal', ownerId: actor.userId }, 'connection-save', id, current => {
      if (!current.administrator) throw new ResearchError('BIO_ACCESS_DENIED');
    }, 'failed');
  }
  hasUnclassifiedProjection(actor: Actor, sessionId: string): boolean {
    this.authorizeResource(actor, 'session', sessionId, 'execute');
    const budget = this.query<{ count: number; bytes: number }, [string]>('SELECT count(*) AS count,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM projection_journal WHERE session_id=?').get(sessionId)!;
    if (budget.count > 1000 || budget.bytes > 8 * 1024 * 1024) throw new ResearchError('BIO_MODEL_BUDGET');
    const rows = this.query<{ payload: string; hash: string; operation_id: string }, [string]>('SELECT payload,hash,operation_id FROM projection_journal WHERE session_id=? ORDER BY sequence').all(sessionId);
    return rows.some(row => !this.provenPublicProjection(actor, sessionId, row));
  }
  private provenPublicProjection(actor: Actor, sessionId: string, row: { payload: string; hash: string; operation_id: string }): boolean {
    if (digest(row.payload) !== row.hash) return false;
    const proof = this.query<{ payload: string }, [string, string]>(`SELECT p.payload FROM run_steps p JOIN entities r ON r.kind='run' AND r.id=p.run_id
      WHERE p.run_id=? AND p.step_id='projection-proof' AND p.state='completed' AND json_extract(r.payload,'$.state')='completed' AND json_extract(r.payload,'$.sessionId')=?`).get(row.operation_id, sessionId);
    if (!proof) return false;
    const data = JSON.parse(proof.payload), prepare = this.researchRunPreparation(actor, row.operation_id);
    if (data.hash !== row.hash || data.manifestId !== prepare.manifest.id || !Array.isArray(data.artifacts) || data.artifacts.length !== 1) return false;
    for (const artifact of data.artifacts) {
      const stored = this.query<{ payload: string }, [string, string]>('SELECT payload FROM entities WHERE kind=? AND id=?').get(artifact.kind, artifact.id);
      if (!stored || digest(stored.payload) !== artifact.hash) return false;
    }
    return true;
  }
  private researchProjectionStatus(actor: Actor, sessionId: string, id: string): 'none' | 'pending' | 'projected' | 'covered' {
    type Row = { sequence: number; projected: number; operation_id: string; payload: string; hash: string };
    const own = this.query<Row, [string, string]>('SELECT * FROM projection_journal WHERE session_id=? AND operation_id=?').get(sessionId, id);
    if (!own) return 'none';
    if (own.projected) return 'projected';
    const latest = this.query<Row, [string]>('SELECT * FROM projection_journal WHERE session_id=? ORDER BY sequence DESC LIMIT 1').get(sessionId)!;
    if (latest.sequence <= own.sequence || !latest.projected || Buffer.byteLength(own.payload) + Buffer.byteLength(latest.payload) > 2 * 1048576) return 'pending';
    if (!this.provenPublicProjection(actor, sessionId, own) || !this.provenPublicProjection(actor, sessionId, latest)) return 'pending';
    const before = JSON.parse(own.payload), after = JSON.parse(latest.payload);
    if (before.format !== 'stored-snapshot' || after.format !== 'stored-snapshot' || before.header.id !== after.header.id || before.header.workspaceRootPath !== after.header.workspaceRootPath ||
        before.messages.length > after.messages.length || JSON.stringify(before.messages) !== JSON.stringify(after.messages.slice(0, before.messages.length))) return 'pending';
    // Keep physical per-snapshot receipts intact; a proven newer full snapshot can
    // nevertheless demonstrate that this run's exact messages reached disk.
    return 'covered';
  }
  recordPublicModelOutcome(actor: Actor, sessionId: string, purpose: 'evidence' | 'report', phase: 'started' | 'finished', outcome: 'success' | 'failed'): void {
    parseContract(IdSchema, sessionId); parseContract(z.enum(['evidence', 'report']), purpose); parseContract(z.enum(['started', 'finished']), phase); parseContract(z.enum(['success', 'failed']), outcome);
    let scope: ResearchScope;
    try { scope = this.binding('session', sessionId); } catch {
      return this.tx(actor, null, `research-model-${purpose}-${phase}`, null, () => { throw new ResearchError('BIO_ACCESS_DENIED'); });
    }
    this.tx(actor, scope, `research-model-${purpose}-${phase}`, sessionId, current => { this.authorizeResource(current, 'session', sessionId, 'execute'); }, outcome);
  }
  artifactOperation<T>(actor: Actor, kind: 'session' | 'source' | 'evidence' | 'report', requestedId: string,
    operation: 'evidence-create' | 'report-create' | 'evidence-save' | 'report-save' | 'evidence-export' | 'report-export' | 'artifact-review' | 'source-metadata-confirm',
    work: () => T, phase: 'request' | 'operation' = 'operation'): T {
    parseContract(z.enum(['session', 'source', 'evidence', 'report']), kind); parseContract(IdSchema, requestedId);
    parseContract(z.enum(['evidence-create', 'report-create', 'evidence-save', 'report-save', 'evidence-export', 'report-export', 'artifact-review', 'source-metadata-confirm']), operation);
    parseContract(z.enum(['request', 'operation']), phase);
    const head = kind === 'evidence' || kind === 'report' ? this.query<{ record_id: string }, [string, string]>(
      'SELECT record_id FROM heads WHERE kind=? AND entity_id=?').get(kind, requestedId) : null;
    let scope: ResearchScope;
    try { scope = this.binding(kind, head?.record_id ?? requestedId); } catch {
      // Unknown IDs stay out of global logs; no user supplied scope or body is trusted.
      return this.tx(actor, null, `artifact-${operation}-${phase}`, null, () => { throw new ResearchError('BIO_ACCESS_DENIED'); });
    }
    return this.tx(actor, scope, `artifact-${operation}-${phase}`, requestedId, current => {
      this.authorize(current, scope, operation.endsWith('-export') ? 'read' : 'write');
      return work();
    });
  }
  sourceHeadForRecord(actor: Actor, recordId: string) {
    const source = parseContract(SourceSchema, this.get(actor, 'source', recordId));
    const row = this.query<{ record_id: string }, [string]>("SELECT record_id FROM heads WHERE kind='source' AND entity_id=?").get(source.sourceIdentityId ?? source.id);
    if (!row) throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
    return parseContract(SourceSchema, this.get(actor, 'source', row.record_id));
  }
  listArtifactHeads(actor: Actor, sessionId: string, pageSize: number, cursor?: string) {
    parseContract(z.number().int().min(1).max(200), pageSize);
    const session = parseContract(SessionSchema, this.get(actor, 'session', sessionId));
    let afterId = '', afterKind = '';
    if (cursor) {
      let decoded: unknown;
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new ResearchError('BIO_INPUT_INVALID'); }
      const page = parseContract(z.strictObject({ sessionId: IdSchema, id: IdSchema, kind: z.enum(['evidence', 'report']) }), decoded);
      if (page.sessionId !== sessionId) throw new ResearchError('BIO_INPUT_INVALID');
      afterId = page.id; afterKind = page.kind;
    }
    return this.tx(actor, session.scope, 'artifact-list', sessionId, current => {
      this.authorize(current, session.scope, 'read');
      const rows = this.query<{ kind: 'evidence' | 'report'; entity_id: string; record_id: string; revision: number; title: string; policy: string; structural: string; human: string; author: string; created: number }, [string, string, string, string, string, number]>(`SELECT h.kind,h.entity_id,h.record_id,h.revision,
        substr(CASE WHEN h.kind='evidence' THEN json_extract(e.payload,'$.claim') ELSE json_extract(e.payload,'$.title') END,1,300) AS title,
        coalesce(json_extract(e.payload,'$.policy'),'unknown') AS policy,json_extract(e.payload,'$.structuralStatus') AS structural,
        coalesce(r.decision,json_extract(e.payload,'$.reviewStatus')) AS human,json_extract(e.payload,'$.authorId') AS author,json_extract(e.payload,'$.createdAt') AS created
        FROM heads h JOIN entities e ON h.kind=e.kind AND h.record_id=e.id LEFT JOIN reviews r ON r.kind=h.kind AND r.record_id=h.record_id WHERE h.kind IN('evidence','report') AND e.scope_key=? AND json_extract(e.payload,'$.sessionId')=?
        AND (h.entity_id>? OR (h.entity_id=? AND h.kind>?)) ORDER BY h.entity_id,h.kind LIMIT ?`).all(scopeKey(session.scope), sessionId, afterId, afterId, afterKind, pageSize + 1);
      const selected = rows.slice(0, pageSize), last = selected.at(-1);
      return parseContract(ArtifactPageSchema, { items: selected.map(row => {
        let title = row.title.slice(0,300);
        if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0,-1);
        return { kind: row.kind, value: { id: row.record_id, entityId: row.entity_id, sessionId, revision: row.revision, title, policy: row.policy,
          structuralStatus: row.structural, reviewStatus: row.human, authorId: row.author, createdAt: row.created } };
      }),
        ...(rows.length > pageSize && last ? { nextCursor: Buffer.from(JSON.stringify({ sessionId, id: last.entity_id, kind: last.kind })).toString('base64url') } : {}) });
    });
  }
  listSourceSnapshots(actor: Actor, sourceId: string, pageSize: number, cursor?: string) {
    parseContract(IdSchema, sourceId); parseContract(z.number().int().min(1).max(100), pageSize)
    const authority = this.authorizeResource(actor, 'source', sourceId, 'read')
    return this.tx(actor, authority.scope, 'snapshot-list', sourceId, current => {
      this.authorize(current, authority.scope, 'read')
      if (cursor) {
        parseContract(IdSchema, cursor)
        this.authorizeResource(current, 'snapshot', cursor, 'read')
        const row = this.query<{ source: string }, [string]>("SELECT json_extract(payload,'$.sourceId') AS source FROM entities WHERE kind='snapshot' AND id=?").get(cursor)
        if (row?.source !== sourceId) throw new ResearchError('BIO_INPUT_INVALID')
      }
      // Project metadata in SQLite: large block bodies never enter this catalog response.
      const rows = this.query<{ summary: string }, [string, string, string, number]>(`SELECT json_object('id',e.id,'sourceId',json_extract(e.payload,'$.sourceId'),
        'policy',json_extract(e.payload,'$.policy'),'format',json_extract(e.payload,'$.format'),'coverageLevel',json_extract(e.payload,'$.coverage.level'),
        'totalUnits',json_extract(e.payload,'$.coverage.totalUnits'),'readUnits',(SELECT count(*) FROM json_each(e.payload,'$.coverage.units') u WHERE json_extract(u.value,'$.status')='read'),
        'retrievedAt',json_extract(e.payload,'$.retrievedAt'),'contentHash',json_extract(e.payload,'$.contentHash')) AS summary
        FROM entities e WHERE e.kind='snapshot' AND e.scope_key=? AND json_extract(e.payload,'$.sourceId')=? AND e.id>? ORDER BY e.id LIMIT ?`).all(scopeKey(authority.scope), sourceId, cursor ?? '', pageSize + 1)
      const items = rows.slice(0, pageSize).map(row => JSON.parse(row.summary))
      return parseContract(SourceSnapshotPageSchema, { items, ...(rows.length > pageSize ? { nextCursor: items.at(-1)!.id } : {}) })
    })
  }
  listArtifactRevisions(actor: Actor, kind: 'evidence' | 'report', entityId: string, pageSize: number, cursor?: string) {
    parseContract(z.enum(['evidence', 'report']), kind); parseContract(IdSchema, entityId); parseContract(z.number().int().min(1).max(100), pageSize)
    const authority = this.authorizeResource(actor, kind, entityId, 'read')
    const head = this.query<{ record_id: string }, [string, string]>('SELECT record_id FROM heads WHERE kind=? AND entity_id=?').get(kind, entityId)
    if (!head) throw new ResearchError('BIO_ACCESS_DENIED')
    return this.tx(actor, authority.scope, 'artifact-history', entityId, current => {
      this.authorize(current, authority.scope, 'read')
      let after = 0
      if (cursor) {
        const value = kind === 'evidence' ? parseContract(EvidenceRevisionSchema, this.get(current, kind, cursor)) : parseContract(ReportRevisionSchema, this.get(current, kind, cursor))
        if (('evidenceId' in value ? value.evidenceId : value.reportId) !== entityId) throw new ResearchError('BIO_INPUT_INVALID')
        after = value.revision
      }
      // Names are fixed enum-derived SQL identifiers; client values are bound parameters.
      const familyPath = kind === 'evidence' ? '$.evidenceId' : '$.reportId', titlePath = kind === 'evidence' ? '$.claim' : '$.title'
      const rows = this.query<{ summary: string }, [string, string, string, number, number]>(`SELECT json_object('id',e.id,'entityId',json_extract(e.payload,'${familyPath}'),
        'sessionId',json_extract(e.payload,'$.sessionId'),'revision',json_extract(e.payload,'$.revision'),'title',substr(json_extract(e.payload,'${titlePath}'),1,300),
        'policy',json_extract(e.payload,'$.policy'),'structuralStatus',json_extract(e.payload,'$.structuralStatus'),'reviewStatus',coalesce(r.decision,json_extract(e.payload,'$.reviewStatus')),
        'authorId',json_extract(e.payload,'$.authorId'),'createdAt',json_extract(e.payload,'$.createdAt')) AS summary
        FROM entities e LEFT JOIN reviews r ON r.kind=e.kind AND r.record_id=e.id WHERE e.kind=? AND e.scope_key=? AND json_extract(e.payload,'${familyPath}')=?
        AND json_extract(e.payload,'$.revision')>? ORDER BY json_extract(e.payload,'$.revision') LIMIT ?`).all(kind, scopeKey(authority.scope), entityId, after, pageSize + 1)
      const items = rows.slice(0, pageSize).map(row => { const value = JSON.parse(row.summary); value.title = value.title.slice(0, 300).replace(/[\uD800-\uDBFF]$/, ''); return { kind, value } })
      return parseContract(ArtifactPageSchema, { items, ...(rows.length > pageSize ? { nextCursor: items.at(-1)!.value.id } : {}) })
    })
  }
  commitArtifact(actor: Actor, kind: 'evidence' | 'report', value: EvidenceRevision | ReportRevision, expectedRevision: number) {
    if (!value.sessionId) throw new ResearchError('BIO_INPUT_INVALID');
    return this.tx(actor, value.scope, 'artifact-save', value.id, current => {
      const session = parseContract(SessionSchema, this.get(current, 'session', value.sessionId!));
      this.authorize(current, session.scope, 'write');
      if (!sameScope(session.scope, value.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
      const saved = this.put(current, kind, value, expectedRevision) as EvidenceRevision | ReportRevision;
      const policy = mergeSessionPolicy(session.policy, [saved.policy ?? 'unknown']);
      if (policy !== session.policy) {
        // Resource classification may only increase. It grants no execution or owner rights.
        const next = parseContract(SessionSchema, { ...session, policy, revision: session.revision + 1 });
        this.query("UPDATE entities SET payload=? WHERE kind='session' AND id=?").run(JSON.stringify(next), session.id);
        this.query("UPDATE heads SET revision=?,policy=? WHERE kind='session' AND entity_id=? AND record_id=?").run(next.revision, policy, session.id, session.id);
        this.event(session.scope, 'session', session.id, next.revision);
      }
      return saved;
    });
  }
  sourceHeads(actor: Actor, scope: ResearchScope): z.infer<typeof SourceSchema>[] {
    return this.tx(actor, scope, 'source-list', null, current => {
      this.authorize(current, scope, 'read');
      const budget = this.query<{ count: number; bytes: number }, [string]>(`SELECT count(*) AS count, coalesce(sum(size),0) AS bytes FROM
        (SELECT length(CAST(e.payload AS BLOB)) AS size FROM entities e JOIN heads h ON h.kind=e.kind AND h.record_id=e.id
        WHERE e.kind='source' AND e.scope_key=? LIMIT 10001)`).get(scopeKey(scope))!;
      if (budget.count > 10000 || budget.bytes > 16 * 1024 * 1024) throw new ResearchError('BIO_PROVIDER_BUDGET');
      const rows = this.query<{ payload: string }, [string]>(`SELECT e.payload FROM entities e JOIN heads h
        ON h.kind=e.kind AND h.record_id=e.id WHERE e.kind='source' AND e.scope_key=? ORDER BY e.id LIMIT 10001`).all(scopeKey(scope));
      if (rows.length > 10000) throw new ResearchError('BIO_PROVIDER_BUDGET');
      return rows.map(row => {
        const source = parseContract(SourceSchema, JSON.parse(row.payload));
        return parseContract(SourceSchema, this.get(current, 'source', source.id));
      });
    });
  }
  abstractSnapshot(actor: Actor, sourceId: string): z.infer<typeof SnapshotSchema> | undefined {
    const source = parseContract(SourceSchema, this.get(actor, 'source', sourceId));
    return this.tx(actor, source.scope, 'snapshot-list', sourceId, current => {
      this.authorize(current, source.scope, 'read');
      const row = this.query<{ payload: string }, [string, string]>(`SELECT payload FROM entities WHERE kind='snapshot'
        AND scope_key=? AND json_extract(payload,'$.sourceId')=? AND json_extract(payload,'$.format')='abstract' ORDER BY id LIMIT 1`).get(scopeKey(source.scope), sourceId);
      return row ? parseContract(SnapshotSchema, JSON.parse(row.payload)) : undefined;
    });
  }
  commitSourceSelection(actor: Actor, sessionId: string, expectedRevision: number, source: z.infer<typeof SourceSchema>,
    newSource: boolean, snapshot?: z.infer<typeof SnapshotSchema>) {
    return this.tx(actor, source.scope, 'source-select', sessionId, current => {
      this.authorizeResource(current, 'session', sessionId, 'execute');
      const session = parseContract(SessionSchema, this.get(current, 'session', sessionId));
      if (session.revision !== expectedRevision) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (!sameScope(session.scope, source.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
      if (newSource) this.put(current, 'source', source, (source.revision ?? 1) - 1);
      else if (JSON.stringify(this.get(current, 'source', source.id)) !== JSON.stringify(source)) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (snapshot) this.put(current, 'snapshot', snapshot);
      const family = source.sourceIdentityId ?? source.id;
      const selectedSourceIds = (session.selectedSourceIds ?? []).filter(id => {
        const old = parseContract(SourceSchema, this.get(current, 'source', id));
        return (old.sourceIdentityId ?? old.id) !== family;
      });
      selectedSourceIds.push(source.id);
      return parseContract(SessionSchema, this.put(current, 'session', { ...session, selectedSourceIds,
        policy: mergeSessionPolicy(session.policy, [source.policy]), revision: session.revision + 1 }, session.revision));
    });
  }
  appendProjection(actor: Actor, sessionId: string, operationId: string, messagesInput: JsonValue[], generation: number): number {
    parseContract(IdSchema, sessionId); parseContract(IdSchema, operationId); parseContract(GenerationSchema, generation);
    const messages = parseContract(z.array(z.json()).min(1).max(10000), messagesInput);
    const messageShape = z.object({ id: IdSchema, role: z.enum(['user', 'assistant', 'tool', 'error', 'status', 'info', 'warning', 'plan', 'auth-request']),
      content: z.union([z.string(), z.array(z.json())]), timestamp: GenerationSchema }).passthrough();
    for (const message of messages) parseContract(messageShape, message);
    const payload = JSON.stringify(messages);
    if (Buffer.byteLength(payload) > 8 * 1024 * 1024) throw new ResearchError('BIO_INPUT_INVALID');
    const session = parseContract(SessionSchema, this.get(actor, 'session', sessionId));
    return this.tx(actor, session.scope, 'projection-append', sessionId, current => {
      this.authorize(current, session.scope, 'write');
      if (session.ownerId !== current.userId) throw new ResearchError('BIO_ACCESS_DENIED');
      const previous = this.query<{ sequence: number; hash: string; generation: number }, [string, string]>(
        'SELECT sequence,hash,generation FROM projection_journal WHERE session_id=? AND operation_id=?',
      ).get(sessionId, operationId);
      const hash = digest(payload);
      if (previous) {
        if (previous.hash !== hash || previous.generation !== generation) throw new ResearchError('BIO_REVISION_CONFLICT');
        return previous.sequence;
      }
      return Number(this.query('INSERT INTO projection_journal(session_id,operation_id,scope_key,generation,payload,hash) VALUES(?,?,?,?,?,?)')
        .run(sessionId, operationId, scopeKey(session.scope), generation, payload, hash).lastInsertRowid);
    });
  }
  appendProjectionSnapshot(actor: Actor, sessionId: string, operationId: string, headerInput: { [key: string]: JsonValue },
    messagesInput: JsonValue[], generation: number): number {
    parseContract(IdSchema, sessionId); parseContract(IdSchema, operationId); parseContract(GenerationSchema, generation);
    const header = parseContract(z.object({ id: IdSchema, workspaceRootPath: z.string().min(1), createdAt: GenerationSchema,
      lastUsedAt: GenerationSchema, messageCount: z.number().int().nonnegative(), tokenUsage: z.record(z.string(), z.json()),
    }).catchall(z.json()), headerInput);
    const messages = parseContract(z.array(z.object({ id: IdSchema,
      type: z.enum(['user', 'assistant', 'tool', 'error', 'status', 'info', 'warning', 'plan', 'auth-request']),
      content: z.string(), timestamp: GenerationSchema.optional(),
    }).catchall(z.json())).max(10000), messagesInput);
    if (header.id !== sessionId || header.messageCount !== messages.length || new Set(messages.map(m => m.id)).size !== messages.length) {
      throw new ResearchError('BIO_INPUT_INVALID');
    }
    const payload = JSON.stringify({ format: 'stored-snapshot', header: headerInput, messages: messagesInput });
    if (Buffer.byteLength(payload) > 8 * 1024 * 1024) throw new ResearchError('BIO_INPUT_INVALID');
    const session = parseContract(SessionSchema, this.get(actor, 'session', sessionId));
    return this.tx(actor, session.scope, 'projection-snapshot', sessionId, current => {
      this.authorize(current, session.scope, 'write');
      if (session.ownerId !== current.userId) throw new ResearchError('BIO_ACCESS_DENIED');
      const hash = digest(payload);
      const previous = this.query<{ sequence: number; hash: string; generation: number }, [string, string]>(
        'SELECT sequence,hash,generation FROM projection_journal WHERE session_id=? AND operation_id=?',
      ).get(sessionId, operationId);
      if (previous) {
        if (previous.hash !== hash || previous.generation !== generation) throw new ResearchError('BIO_REVISION_CONFLICT');
        return previous.sequence;
      }
      const latest = this.query<{ generation: number }, [string]>(
        'SELECT generation FROM projection_journal WHERE session_id=? ORDER BY sequence DESC LIMIT 1',
      ).get(sessionId);
      if (latest && generation <= latest.generation) throw new ResearchError('BIO_REVISION_CONFLICT');
      return Number(this.query('INSERT INTO projection_journal(session_id,operation_id,scope_key,generation,payload,hash) VALUES(?,?,?,?,?,?)')
        .run(sessionId, operationId, scopeKey(session.scope), generation, payload, hash).lastInsertRowid);
    });
  }
  markProjected(actor: Actor, sessionId: string, operationId: string, generation: number, hash: string): void {
    parseContract(IdSchema, sessionId); parseContract(IdSchema, operationId); parseContract(GenerationSchema, generation);
    parseContract(z.string().regex(/^[a-f0-9]{64}$/), hash);
    const session = parseContract(SessionSchema, this.get(actor, 'session', sessionId));
    this.tx(actor, session.scope, 'projection-confirm', sessionId, current => {
      this.authorize(current, session.scope, 'write');
      if (session.ownerId !== current.userId) throw new ResearchError('BIO_ACCESS_DENIED');
      const latest = this.query<{ operation_id: string; generation: number; hash: string }, [string]>(
        'SELECT operation_id,generation,hash FROM projection_journal WHERE session_id=? ORDER BY sequence DESC LIMIT 1',
      ).get(sessionId);
      if (latest?.operation_id !== operationId || latest.generation !== generation || latest.hash !== hash) {
        throw new ResearchError('BIO_REVISION_CONFLICT');
      }
      this.query('UPDATE projection_journal SET projected=1 WHERE session_id=? AND operation_id=?').run(sessionId, operationId);
    });
  }
  confirmSourceMetadata(actor: Actor, id: string, expectedRevision: number, now: number) {
    const source = parseContract(SourceSchema, this.get(actor, 'source', id));
    parseContract(GenerationSchema, now); parseContract(RevisionSchema, expectedRevision);
    return this.tx(actor, source.scope, 'source-metadata-review', id, current => {
      this.authorize(current, source.scope, 'write');
      const value = parseContract(SourceSchema, this.get(current, 'source', id));
      if ((value.revision ?? 1) !== expectedRevision || value.metadataReview) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (!value.metadataConflictFields?.length || now < value.createdAt) throw new ResearchError('BIO_INPUT_INVALID');
      this.query('INSERT INTO reviews VALUES(?,?,?,?,?,?)').run('source', id, 'confirmed', current.userId, now, expectedRevision);
      this.event(source.scope, 'source-metadata-review', id, expectedRevision);
      return parseContract(SourceSchema, this.get(current, 'source', id));
    });
  }
  reviewRevision(actor: Actor, kind: 'evidence' | 'report', id: string, expectedRevision: number,
    decision: 'confirmed' | 'needs-changes', now: number): EvidenceRevision | ReportRevision {
    parseContract(z.enum(['evidence', 'report']), kind); parseContract(IdSchema, id);
    parseContract(GenerationSchema, expectedRevision); parseContract(GenerationSchema, now);
    parseContract(z.enum(['confirmed', 'needs-changes']), decision);
    const scope = this.binding(kind, id);
    return this.tx(actor, scope, 'human-review', id, current => {
      this.authorize(current, scope, 'write');
      const value = kind === 'evidence' ? parseContract(EvidenceRevisionSchema, this.get(current, kind, id)) :
        parseContract(ReportRevisionSchema, this.get(current, kind, id));
      const entityId = 'evidenceId' in value ? value.evidenceId : value.reportId;
      const head = this.query<HeadRow, [string, string]>('SELECT * FROM heads WHERE kind=? AND entity_id=?').get(kind, entityId);
      if (value.revision !== expectedRevision || head?.record_id !== id || head.revision !== expectedRevision) {
        throw new ResearchError('BIO_REVISION_CONFLICT');
      }
      if (this.query<{ record_id: string }, [string, string]>('SELECT record_id FROM reviews WHERE kind=? AND record_id=?').get(kind, id)) throw new ResearchError('BIO_REVISION_CONFLICT');
      const next = parseContract((kind === 'evidence' ? EvidenceRevisionSchema : ReportRevisionSchema) as z.ZodType<EvidenceRevision | ReportRevision>, {
        ...value, reviewStatus: decision, review: { reviewerId: current.userId, reviewedAt: now, revisionId: id, revisionNumber: expectedRevision },
      });
      this.query('INSERT INTO reviews VALUES(?,?,?,?,?,?)')
        .run(kind, id, decision, current.userId, now, expectedRevision);
      this.event(scope, 'human-review', id, expectedRevision);
      return next;
    });
  }
  beginResearchRun(actor: Actor, raw: unknown, prepared?: PreparedPublicInput, now = Date.now()): ResearchRunView {
    const request = parseContract(StartResearchRunSchema, raw), session = parseContract(SessionSchema, this.get(actor, 'session', request.sessionId));
    parseContract(GenerationSchema, now);
    return this.tx(actor, session.scope, 'research-run-create', session.id, current => {
      this.authorizeResource(current, 'session', session.id, 'execute');
      const fingerprint = digest(JSON.stringify(request));
      const previous = this.query<{ run_id: string; fingerprint: string }, [string, string]>(`SELECT i.run_id,i.fingerprint FROM run_intents i JOIN entities e ON e.kind='run' AND e.id=i.run_id
        WHERE json_extract(e.payload,'$.sessionId')=? AND i.operation_id=?`).get(session.id, request.operationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ResearchError('BIO_REVISION_CONFLICT');
        return this.researchRunView(current, previous.run_id);
      }
      if (session.revision !== request.expectedRevision) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (this.query(`SELECT 1 FROM entities WHERE kind='run' AND json_extract(payload,'$.sessionId')=? AND json_extract(payload,'$.state') IN('queued','running')`).get(session.id)) throw new ResearchError('BIO_RUN_ACTIVE');
      if (!prepared) throw new ResearchError('BIO_INPUT_INVALID');
      prepared.assertCurrent();
      const manifest = parseContract(PublicInputManifestSchema, prepared.manifest);
      const modelInput = parseContract(PublicModelInputSchema, prepared.modelInput);
      if (manifest.actorId !== current.userId || manifest.sessionId !== session.id || manifest.sessionRevision !== session.revision || !sameScope(manifest.scope, session.scope) || manifest.contextHash !== digest(JSON.stringify(modelInput)) ||
          manifest.connectionId !== request.connectionId || manifest.model !== request.model || modelInput.question !== request.question ||
          JSON.stringify(modelInput.blocks.map(({ snapshotId, blockId, start, end }) => ({ snapshotId, blockId, start, end }))) !== JSON.stringify(request.blocks) ||
          JSON.stringify(modelInput.evidence.map(item => item.id)) !== JSON.stringify(request.evidenceRevisionIds)) throw new ResearchError('BIO_REVISION_CONFLICT');
      const run = parseContract(RunSchema, { id: randomUUID(), sessionId: session.id, scope: session.scope, actorId: current.userId, connectionId: request.connectionId,
        state: 'queued', generation: 0, revision: 1, sourceIds: [...new Set(prepared.modelInput.blocks.map(block => block.sourceId))], artifactIds: [], createdAt: now, step: 'prepare' });
      const payload = JSON.stringify({ request, manifest, modelInput, connectionFingerprint: prepared.connection.fingerprint });
      if (Buffer.byteLength(payload) > 262144) throw new ResearchError('BIO_MODEL_BUDGET');
      this.put(current, 'run', run);
      this.query('INSERT INTO run_steps VALUES(?,?,?,?)').run(run.id, 'prepare', 'completed', payload);
      this.query('INSERT INTO run_intents VALUES(?,?,?,?)').run(run.id, request.operationId, fingerprint, 'accepted');
      return this.researchRunView(current, run.id);
    });
  }
  researchRunReplay(actor: Actor, raw: unknown): ResearchRunView | undefined {
    const request = parseContract(StartResearchRunSchema, raw);
    this.authorizeResource(actor, 'session', request.sessionId, 'execute');
    const previous = this.query<{ run_id: string; fingerprint: string }, [string, string]>(`SELECT i.run_id,i.fingerprint FROM run_intents i JOIN entities e ON e.kind='run' AND e.id=i.run_id
      WHERE json_extract(e.payload,'$.sessionId')=? AND i.operation_id=?`).get(request.sessionId, request.operationId);
    if (!previous) return undefined;
    if (previous.fingerprint !== digest(JSON.stringify(request))) throw new ResearchError('BIO_REVISION_CONFLICT');
    return this.researchRunView(actor, previous.run_id);
  }
  researchRunView(actor: Actor, id: string): ResearchRunView {
    const run = parseContract(RunSchema, this.get(actor, 'run', id));
    const prepared = this.researchRunPreparation(actor, id), request = prepared.request;
    const modelRequests = this.query<{ operation_id: string; state: string }, [string]>("SELECT operation_id,state FROM run_intents WHERE run_id=? AND operation_id LIKE 'model:%' ORDER BY operation_id LIMIT 5").all(id)
      .map(item => ({ callId: item.operation_id.slice(6), state: item.state }));
    const steps = this.query<{ step_id: string; state: string }, [string]>("SELECT step_id,state FROM run_steps WHERE run_id=? AND step_id!='projection-proof' ORDER BY step_id LIMIT 9").all(id).map(row => ({ id: row.step_id, state: row.state }));
    const failure = this.query<{ payload: string }, [string]>("SELECT payload FROM run_steps WHERE run_id=? AND step_id='failure'").get(id);
    const projectionStatus = this.researchProjectionStatus(actor, run.sessionId, id), projectionPending = projectionStatus === 'pending';
    return parseContract(ResearchRunViewSchema, { run, operationId: request.operationId, purpose: request.purpose, manifest: prepared.manifest, input: prepared.modelInput, modelRequests, steps, projectionPending, projectionStatus,
      ...(failure ? { errorCode: JSON.parse(failure.payload).errorCode } : {}) });
  }
  listResearchRuns(actor: Actor, sessionId: string, pageSize: number, cursor?: string) {
    parseContract(z.number().int().min(1).max(100), pageSize); if (cursor) parseContract(IdSchema, cursor);
    const session = parseContract(SessionSchema, this.get(actor, 'session', sessionId));
    return this.tx(actor, session.scope, 'research-run-list', sessionId, current => {
      this.authorize(current, session.scope, 'read');
      const rows = this.query<{ id: string }, [string, string, number]>("SELECT id FROM entities WHERE kind='run' AND json_extract(payload,'$.sessionId')=? AND id>? ORDER BY id LIMIT ?").all(sessionId, cursor ?? '', pageSize + 1);
      const items = rows.slice(0, pageSize).map(row => parseContract(RunSchema, this.get(current, 'run', row.id)));
      return { items, ...(rows.length > pageSize ? { nextCursor: items.at(-1)!.id } : {}) };
    });
  }
  researchRunPreparation(actor: Actor, id: string) {
    this.get(actor, 'run', id);
    const row = this.query<{ payload: string }, [string]>("SELECT payload FROM run_steps WHERE run_id=? AND step_id='prepare'").get(id);
    if (!row || Buffer.byteLength(row.payload) > 262144) throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
    const record = parseContract(z.strictObject({ request: StartResearchRunSchema, manifest: PublicInputManifestSchema, modelInput: PublicModelInputSchema, connectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }), JSON.parse(row.payload));
    if (record.manifest.contextHash !== digest(JSON.stringify(record.modelInput))) throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
    return record;
  }
  /** Service-only authority derived from persisted ownership; never registered as RPC. */
  researchExecutionActor(id: string): Actor {
    parseContract(IdSchema, id); this.assertWriter();
    const row = this.query<{ payload: string }, [string]>("SELECT payload FROM entities WHERE kind='run' AND id=?").get(id);
    if (!row) throw new ResearchError('BIO_ACCESS_DENIED');
    const run = parseContract(RunSchema, JSON.parse(row.payload));
    const actor = this.currentActor({ userId: run.actorId, authSessionId: run.id, administrator: false, active: true });
    this.authorizeResource(actor, 'session', run.sessionId, 'execute');
    return actor;
  }
  assertResearchRunLease(actor: Actor, id: string, generation: number, workerId: string, now = Date.now()): ResearchRun {
    const run = parseContract(RunSchema, this.get(actor, 'run', id));
    this.authorizeResource(actor, 'session', run.sessionId, 'execute');
    if (actor.userId !== run.actorId || run.state !== 'running' || run.generation !== generation || run.lease?.workerId !== workerId || run.lease.expiresAt <= now) throw new ResearchError('BIO_REVISION_CONFLICT');
    return run;
  }
  recordResearchModelAttempt(actor: Actor, id: string, generation: number, workerId: string, manifestId: string, raw: unknown, now = Date.now()): void {
    const event = parseContract(z.discriminatedUnion('phase', [z.strictObject({ phase: z.literal('send'), callId: z.string().regex(/^call-[1-4]$/) }),
      z.strictObject({ phase: z.literal('received'), callId: z.string().regex(/^call-[1-4]$/), outcome: z.enum(['completed', 'rejected']) })]), raw);
    const scope = this.binding('run', id);
    this.tx(actor, scope, 'research-model-intent', id, current => {
      this.assertResearchRunLease(current, id, generation, workerId, now);
      const { manifest, connectionFingerprint, request } = this.researchRunPreparation(current, id);
      if (manifest.id !== manifestId) throw new ResearchError('BIO_REVISION_CONFLICT');
      const fingerprint = digest(JSON.stringify({ manifest, connectionFingerprint, purpose: request.purpose, generation, callId: event.callId })), operation = `model:${event.callId}`;
      const previous = this.query<{ fingerprint: string; state: string }, [string, string]>('SELECT fingerprint,state FROM run_intents WHERE run_id=? AND operation_id=?').get(id, operation);
      if (event.phase === 'send') {
        const count = this.query<{ count: number }, [string]>("SELECT count(*) AS count FROM run_intents WHERE run_id=? AND operation_id LIKE 'model:%'").get(id)!.count;
        const pending = this.query("SELECT 1 FROM run_intents WHERE run_id=? AND operation_id LIKE 'model:%' AND state IN('pending','unknown')").get(id);
        if (previous || pending || count >= 4 || event.callId !== `call-${count + 1}`) throw new ResearchError('BIO_REVISION_CONFLICT');
        this.query('INSERT INTO run_intents VALUES(?,?,?,?)').run(id, operation, fingerprint, 'pending');
      } else {
        if (previous?.fingerprint !== fingerprint || previous.state !== 'pending') throw new ResearchError('BIO_REVISION_CONFLICT');
        this.query('UPDATE run_intents SET state=? WHERE run_id=? AND operation_id=?').run(event.outcome, id, operation);
      }
      const run = parseContract(RunSchema, this.get(current, 'run', id));
      this.event(scope, 'run', id, run.revision);
    });
  }
  researchRetryCandidate(actor: Actor, previousId: string, prepared: PreparedPublicInput, purpose: 'evidence' | 'report'): PublicCandidateResult | undefined {
    const previous = this.researchRunPreparation(actor, previousId);
    if (previous.manifest.sessionId !== prepared.manifest.sessionId || !sameScope(previous.manifest.scope, prepared.manifest.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
    if (previous.manifest.contextHash !== prepared.manifest.contextHash || previous.connectionFingerprint !== prepared.connection.fingerprint || previous.request.purpose !== purpose) return undefined;
    const row = this.query<{ payload: string }, [string]>("SELECT payload FROM run_steps WHERE run_id=? AND step_id='model-result' AND state='completed'").get(previousId);
    if (!row) return undefined;
    if (Buffer.byteLength(row.payload) > 262144) throw new ResearchError('BIO_MODEL_BUDGET');
    return parseContract(PublicCandidateResultSchema, JSON.parse(row.payload));
  }
  saveResearchCandidate(actor: Actor, id: string, generation: number, workerId: string, raw: PublicCandidateResult, prepared: PreparedPublicInput, reusedFrom?: string): void {
    this.tx(actor, this.binding('run', id), 'research-model-result', id, current => {
      this.assertResearchRunLease(current, id, generation, workerId);
      const candidate = parseContract(PublicCandidateResultSchema, raw), record = this.researchRunPreparation(current, id);
      if (record.manifest.id !== prepared.manifest.id || record.manifest.contextHash !== prepared.manifest.contextHash || candidate.kind !== record.request.purpose) throw new ResearchError('BIO_REVISION_CONFLICT');
      const unsettled = this.query("SELECT 1 FROM run_intents WHERE run_id=? AND operation_id LIKE 'model:%' AND state IN('pending','unknown')").get(id);
      const received = this.query("SELECT 1 FROM run_intents WHERE run_id=? AND operation_id LIKE 'model:%' AND state='completed'").get(id);
      if (unsettled || (!received && (!reusedFrom || JSON.stringify(this.researchRetryCandidate(current, reusedFrom, prepared, record.request.purpose)) !== JSON.stringify(candidate)))) throw new ResearchError('BIO_REVISION_CONFLICT');
      const payload = JSON.stringify(candidate);
      if (Buffer.byteLength(payload) > 262144) throw new ResearchError('BIO_MODEL_BUDGET');
      this.query('INSERT INTO run_steps VALUES(?,?,?,?)').run(id, 'model-result', 'completed', payload);
      if (reusedFrom) this.query('INSERT INTO run_steps VALUES(?,?,?,?)').run(id, 'reuse', 'completed', JSON.stringify({ runId: reusedFrom }));
    });
  }
  researchRetryArtifact(actor: Actor, id: string): { kind: 'evidence' | 'report'; id: string } | undefined {
    const record = this.researchRunPreparation(actor, id), previousId = record.request.retryOfRunId;
    if (!previousId) return undefined;
    const previous = this.researchRunPreparation(actor, previousId), run = parseContract(RunSchema, this.get(actor, 'run', previousId));
    if (previous.manifest.sessionId !== record.manifest.sessionId || !sameScope(previous.manifest.scope, record.manifest.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
    if (run.state !== 'completed' || run.artifactIds.length !== 1 || previous.manifest.contextHash !== record.manifest.contextHash || previous.connectionFingerprint !== record.connectionFingerprint || previous.request.purpose !== record.request.purpose) return undefined;
    const proof = this.query<{ payload: string }, [string]>("SELECT payload FROM run_steps WHERE run_id=? AND step_id='projection-proof' AND state='completed'").get(previousId);
    const artifact = { kind: record.request.purpose, id: run.artifactIds[0]! }, raw = this.query<{ payload: string }, [string, string]>('SELECT payload FROM entities WHERE kind=? AND id=?').get(artifact.kind, artifact.id);
    if (!proof || !raw || !JSON.parse(proof.payload).artifacts.some((item: { id: string; kind: string; hash: string }) => item.id === artifact.id && item.kind === artifact.kind && item.hash === digest(raw.payload))) throw new ResearchError('BIO_STORAGE_UNAVAILABLE');
    this.get(actor, artifact.kind, artifact.id);
    return artifact;
  }
  completeResearchRun(actor: Actor, id: string, generation: number, workerId: string, work: () => { artifact: { kind: 'evidence' | 'report'; id: string }; header: { [key: string]: JsonValue }; messages: JsonValue[] }, now = Date.now()): ResearchRunView {
    return this.tx(actor, this.binding('run', id), 'research-run-complete', id, current => {
      const run = this.assertResearchRunLease(current, id, generation, workerId, now);
      const unsettled = this.query("SELECT 1 FROM run_intents WHERE run_id=? AND operation_id LIKE 'model:%' AND state IN('pending','unknown')").get(id);
      const validated = this.query("SELECT 1 FROM run_steps WHERE run_id=? AND step_id='model-result' AND state='completed'").get(id);
      if (unsettled || !validated) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (this.hasUnclassifiedProjection(current, run.sessionId)) throw new ResearchError('BIO_POLICY_DENIED');
      const result = work(), artifact = this.get(current, result.artifact.kind, result.artifact.id);
      const reusable = this.researchRetryArtifact(current, id), reused = reusable?.id === result.artifact.id && reusable.kind === result.artifact.kind;
      if (!('sessionId' in artifact) || artifact.sessionId !== run.sessionId || !sameScope(artifact.scope, run.scope) || !('reviewStatus' in artifact) || !reused && artifact.reviewStatus !== 'unreviewed' || artifact.policy !== 'public') throw new ResearchError('BIO_INPUT_INVALID');
      const payload = JSON.stringify({ artifact: result.artifact });
      this.query('INSERT INTO run_steps VALUES(?,?,?,?)').run(id, 'validate', 'completed', '{}');
      this.query('INSERT INTO run_steps VALUES(?,?,?,?)').run(id, this.researchRunPreparation(current, id).request.purpose, 'completed', payload);
      const latest = this.query<{ generation: number }, [string]>('SELECT generation FROM projection_journal WHERE session_id=? ORDER BY sequence DESC LIMIT 1').get(run.sessionId);
      if (result.messages.length > 1000 || Buffer.byteLength(JSON.stringify(result)) > 1048576) throw new ResearchError('BIO_MODEL_BUDGET');
      this.appendProjectionSnapshot(current, run.sessionId, id, result.header, result.messages, (latest?.generation ?? 0) + 1);
      const journal = this.query<{ hash: string }, [string, string]>('SELECT hash FROM projection_journal WHERE session_id=? AND operation_id=?').get(run.sessionId, id)!;
      const raw = this.query<{ payload: string }, [string, string]>('SELECT payload FROM entities WHERE kind=? AND id=?').get(result.artifact.kind, result.artifact.id)!;
      const manifest = this.researchRunPreparation(current, id).manifest;
      this.query('INSERT INTO run_steps VALUES(?,?,?,?)').run(id, 'projection-proof', 'completed', JSON.stringify({ hash: journal.hash, manifestId: manifest.id, artifacts: [{ ...result.artifact, hash: digest(raw.payload) }] }));
      const completed = this.advanceRun(current, id, 'completed', generation, workerId, now);
      const finalRun = parseContract(RunSchema, { ...completed, artifactIds: [result.artifact.id], step: this.researchRunPreparation(current, id).request.purpose });
      this.query("UPDATE entities SET payload=? WHERE kind='run' AND id=?").run(JSON.stringify(finalRun), id);
      return this.researchRunView(current, id);
    });
  }
  failResearchRun(actor: Actor, id: string, generation: number, workerId: string, errorCode: string, now = Date.now()): void {
    this.tx(actor, this.binding('run', id), 'research-run-failed', id, current => {
      this.assertResearchRunLease(current, id, generation, workerId, now);
      parseContract(z.enum(Object.keys(BIO_ERROR_MESSAGES) as [keyof typeof BIO_ERROR_MESSAGES, ...(keyof typeof BIO_ERROR_MESSAGES)[]]), errorCode);
      this.query('INSERT INTO run_steps VALUES(?,?,?,?)').run(id, 'failure', 'failed', JSON.stringify({ errorCode }));
      this.advanceRun(current, id, 'failed', generation, workerId, now);
    });
  }
  interruptResearchRun(id: string, now = Date.now()): void {
    parseContract(IdSchema, id); parseContract(GenerationSchema, now);
    this.db.transaction(() => {
      this.assertWriter();
      const row = this.query<{ payload: string }, [string]>("SELECT payload FROM entities WHERE kind='run' AND id=?").get(id);
      if (!row) throw new ResearchError('BIO_ACCESS_DENIED');
      const run = parseContract(RunSchema, JSON.parse(row.payload));
      if (!['queued', 'running'].includes(run.state)) return;
      const result = transitionRun(run, 'interrupted', run.generation, Math.max(now, run.startedAt ?? run.createdAt));
      this.query("UPDATE entities SET payload=? WHERE kind='run' AND id=?").run(JSON.stringify(result), id);
      this.query("UPDATE heads SET revision=? WHERE kind='run' AND entity_id=?").run(result.revision, id);
      this.query('DELETE FROM run_leases WHERE run_id=?').run(id);
      this.query("UPDATE run_intents SET state='unknown' WHERE run_id=? AND state='pending'").run(id);
      this.audit(run.actorId, run.scope, 'research-run-interrupted', 'success', id); this.event(run.scope, 'run', id, result.revision);
    }).immediate();
  }
  /** Called once before accepting requests; interruption never replays external effects. */
  recoverResearchRuns(now = Date.now()): number {
    parseContract(GenerationSchema, now);
    return this.db.transaction(() => {
      this.assertWriter();
      const rows = this.query<{ payload: string }, []>("SELECT payload FROM entities WHERE kind='run' AND json_extract(payload,'$.state') IN('queued','running')").all();
      for (const row of rows) {
        const run = parseContract(RunSchema, JSON.parse(row.payload)), result = transitionRun(run, 'interrupted', run.generation, Math.max(now, run.startedAt ?? run.createdAt));
        this.query("UPDATE entities SET payload=? WHERE kind='run' AND id=?").run(JSON.stringify(result), run.id);
        this.query("UPDATE heads SET revision=? WHERE kind='run' AND entity_id=?").run(result.revision, run.id);
        this.query('DELETE FROM run_leases WHERE run_id=?').run(run.id);
        this.query("UPDATE run_intents SET state='unknown' WHERE run_id=? AND state='pending'").run(run.id);
        this.audit(run.actorId, run.scope, 'research-run-recovered', 'success', run.id); this.event(run.scope, 'run', run.id, result.revision);
      }
      return rows.length;
    }).immediate();
  }
  publishResearchOutbox(publish: (event: ResearchEvent) => void): number {
    this.assertWriter();
    const rows = this.query<{ sequence: number; scope_json: string; kind: string; resource_id: string; revision: number }, []>(`SELECT o.*,s.scope_json FROM outbox o JOIN spaces s USING(scope_key) WHERE o.delivered=0 ORDER BY o.sequence LIMIT 100`).all();
    for (const row of rows) {
      const kinds = { run: 'run-changed', session: 'session-changed', evidence: 'evidence-changed', report: 'report-changed' } as const;
      const kind = kinds[row.kind as keyof typeof kinds];
      if (kind) {
        const entity = this.query<{ session_id: string | null }, [string, string]>("SELECT json_extract(payload,'$.sessionId') AS session_id FROM entities WHERE kind=? AND id=?").get(row.kind, row.resource_id);
        const sessionId = row.kind === 'session' ? row.resource_id : entity?.session_id;
        if (sessionId) publish({ version: 1, id: `outbox-${row.sequence}`, sequence: row.sequence, scope: parseContract(ScopeSchema, JSON.parse(row.scope_json)),
          kind, sessionId, resourceId: row.resource_id, revision: row.revision });
      }
      // Publication is not a client receipt. Reconnect always queries authoritative state.
      this.query('UPDATE outbox SET delivered=1 WHERE sequence=?').run(row.sequence);
    }
    return rows.length;
  }
  pendingResearchProjections(afterId = ''): string[] {
    this.assertWriter(); if (afterId) parseContract(IdSchema, afterId);
    return this.query<{ id: string }, [string]>(`SELECT r.id FROM entities r JOIN projection_journal j ON j.operation_id=r.id
      WHERE r.kind='run' AND r.id>? AND json_extract(r.payload,'$.state')='completed' AND j.projected=0
      AND j.sequence=(SELECT max(p.sequence) FROM projection_journal p WHERE p.session_id=j.session_id) ORDER BY r.id LIMIT 20`).all(afterId).map(row => row.id);
  }
  advanceRun(actor: Actor, id: string, nextInput: RunState, expectedGeneration: number, workerId: string | null,
    now: number, leaseExpiresAt?: number): ResearchRun {
    parseContract(IdSchema, id); parseContract(GenerationSchema, expectedGeneration); parseContract(GenerationSchema, now);
    const next = parseContract(RunStateSchema, nextInput);
    const scope = this.binding('run', id);
    return this.tx(actor, scope, 'run-transition', id, current => {
      const run = parseContract(RunSchema, this.get(current, 'run', id));
      const session = parseContract(SessionSchema, this.get(current, 'session', run.sessionId));
      const member = scope.kind === 'project' ? this.query<{ role: 'owner' | 'editor' | 'viewer'; active: number }, [string, string]>(
        'SELECT role,active FROM members WHERE project_id=? AND user_id=?',
      ).get(scope.projectId, current.userId) : null;
      assertSessionControl(current, session, member && scope.kind === 'project' ? {
        projectId: scope.projectId, userId: current.userId, role: member.role, active: member.active === 1,
      } : null, next === 'cancelled' ? 'cancel' : 'execute');
      if (run.actorId !== current.userId || run.generation !== expectedGeneration) throw new ResearchError('BIO_REVISION_CONFLICT');
      const lease = this.query<{ worker_id: string; generation: number; expires_at: number }, [string]>(
        'SELECT worker_id,generation,expires_at FROM run_leases WHERE run_id=?',
      ).get(id);
      if (next === 'completed' || next === 'failed') {
        if (!lease || lease.worker_id !== workerId || lease.generation !== expectedGeneration || lease.expires_at <= now) {
          throw new ResearchError('BIO_REVISION_CONFLICT');
        }
      }
      const proposedLease = next === 'running' ? { runId: id, workerId: parseContract(IdSchema, workerId),
        generation: expectedGeneration, expiresAt: parseContract(GenerationSchema, leaseExpiresAt) } : undefined;
      const result = transitionRun(run, next, expectedGeneration, now, proposedLease);
      const head = this.query<HeadRow, [string, string]>('SELECT * FROM heads WHERE kind=? AND entity_id=?').get('run', id);
      if (head?.revision !== run.revision || head.record_id !== id) throw new ResearchError('BIO_REVISION_CONFLICT');
      this.query('UPDATE entities SET payload=? WHERE kind=? AND id=?').run(JSON.stringify(result), 'run', id);
      this.query('UPDATE heads SET revision=? WHERE kind=? AND entity_id=? AND revision=?').run(result.revision, 'run', id, run.revision);
      this.query('DELETE FROM run_leases WHERE run_id=?').run(id);
      if (result.lease) this.query('INSERT INTO run_leases VALUES(?,?,?,?)').run(id, result.lease.workerId, result.lease.generation, result.lease.expiresAt);
      if (['failed', 'cancelled', 'interrupted'].includes(result.state)) this.query("UPDATE run_intents SET state='unknown' WHERE run_id=? AND state='pending'").run(id);
      this.event(scope, 'run', id, result.revision);
      return result;
    });
  }
  readProjection(actor: Actor, sessionId: string, forWrite = false): ProjectionEntry[] {
    const session = parseContract(SessionSchema, this.get(actor, 'session', sessionId));
    if (forWrite) this.tx(actor, session.scope, 'projection-authorize', sessionId, current => {
      this.authorize(current, session.scope, 'write');
      if (session.ownerId !== current.userId) throw new ResearchError('BIO_ACCESS_DENIED');
    });
    return this.query<{ sequence: number; operation_id: string; generation: number; payload: string; hash: string; projected: number }, [string]>(
      'SELECT * FROM projection_journal WHERE session_id=? ORDER BY sequence',
    ).all(sessionId).map(row => {
      const payload = JSON.parse(row.payload);
      return { sequence: row.sequence, sessionId, operationId: row.operation_id,
        generation: row.generation, hash: row.hash, projected: row.projected === 1,
        ...(Array.isArray(payload) ? { format: 'legacy-runtime' as const, messages: payload as JsonValue[] } :
          { format: 'stored-snapshot' as const, header: payload.header, messages: payload.messages }) };
    });
  }
  readAudit(actor: Actor, input: ResearchScope, pageSize = 100, afterSequence = 0) {
    const scope = parseContract(ScopeSchema, input);
    parseContract(z.number().int().min(1).max(200), pageSize); parseContract(GenerationSchema, afterSequence);
    this.authorize(actor, scope, scope.kind === 'project' ? 'manage' : 'read');
    return this.query<{ id: number; actor_id: string; created_at: number; action: string; outcome: string; resource_id: string | null }, [string, number, number]>(
      'SELECT id,actor_id,created_at,action,outcome,resource_id FROM audit WHERE scope_key=? AND id>? ORDER BY id LIMIT ?',
    ).all(scopeKey(scope), afterSequence, pageSize).map(row => ({ sequence: row.id, actorId: row.actor_id, createdAt: row.created_at,
      action: row.action, outcome: row.outcome, resourceId: row.resource_id }));
  }
  readAuditEntries(actor: Actor, input: ResearchScope, sequences: number[]) {
    const scope = parseContract(ScopeSchema, input);
    parseContract(z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(200), sequences);
    this.authorize(actor, scope, scope.kind === 'project' ? 'manage' : 'read');
    return this.query<{ id: number; actor_id: string; created_at: number; action: string; outcome: string; resource_id: string | null }, [string, string]>(
      'SELECT id,actor_id,created_at,action,outcome,resource_id FROM audit WHERE scope_key=? AND id IN(SELECT value FROM json_each(?)) ORDER BY id',
    ).all(scopeKey(scope), JSON.stringify(sequences)).map(row => ({ sequence: row.id, actorId: row.actor_id, createdAt: row.created_at,
      action: row.action, outcome: row.outcome, resourceId: row.resource_id }));
  }
  installDeploymentGrants(grants: StoredDeploymentGrant[]): void {
    const parsed = parseContract(z.array(DeploymentGrantSchema.extend({ authorityHash: z.string().regex(/^[a-f0-9]{64}$/), active: z.boolean() })).max(1000), grants);
    if (new Set(parsed.map(grant => grant.id)).size !== parsed.length) throw new ResearchError('BIO_INPUT_INVALID');
    this.db.transaction(() => {
      this.assertWriter();
      this.query('UPDATE root_grants SET active=0').run();
      for (const grant of parsed) {
        const existing = this.query<{ scope_key: string; root_path: string; authority_hash: string }, [string]>('SELECT * FROM root_grants WHERE id=?').get(grant.id);
        if (existing && (existing.scope_key !== scopeKey(grant.scope) || existing.root_path !== grant.rootPath || existing.authority_hash !== grant.authorityHash)) {
          throw new ResearchError('BIO_REVISION_CONFLICT');
        }
        this.query('INSERT INTO root_grants VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active')
          .run(grant.id, scopeKey(grant.scope), grant.rootPath, grant.authorityHash, Number(grant.active));
      }
    }).immediate();
  }
  materialGrant(actor: Actor, grantId: string, manage = false): StoredDeploymentGrant {
    parseContract(IdSchema, grantId);
    const row = this.query<{ root_path: string; authority_hash: string; active: number; scope_json: string }, [string]>(
      'SELECT r.root_path,r.authority_hash,r.active,s.scope_json FROM root_grants r JOIN spaces s ON s.scope_key=r.scope_key WHERE r.id=?',
    ).get(grantId);
    if (!row || row.active !== 1) throw new ResearchError('BIO_ACCESS_DENIED');
    const scope = parseContract(ScopeSchema, JSON.parse(row.scope_json));
    this.authorizeScope(actor, scope, manage ? 'manage' : 'read');
    return { id: grantId, scope, label: grantId, rootPath: row.root_path, authorityHash: row.authority_hash, active: true };
  }
  createMaterialRoot(actor: Actor, input: MaterialRoot): MaterialRoot {
    const material = parseContract(MaterialRootSchema, input), grant = this.materialGrant(actor, material.grantId, true);
    if (!sameScope(material.scope, grant.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
    return this.tx(actor, material.scope, 'material-register', material.id, current => {
      this.authorize(current, material.scope, 'manage');
      this.query('INSERT INTO materials VALUES(?,?,?,?)').run(material.id, material.grantId, scopeKey(material.scope), JSON.stringify({ root: material, directories: {} }));
      return material;
    });
  }
  materialRoot(actor: Actor, rootId: string): MaterialRoot {
    parseContract(IdSchema, rootId);
    const row = this.query<{ grant_id: string; scope_json: string; metadata: string }, [string]>(
      'SELECT m.grant_id,m.metadata,s.scope_json FROM materials m JOIN spaces s ON s.scope_key=m.scope_key WHERE m.id=?',
    ).get(rootId);
    if (!row) throw new ResearchError('BIO_ACCESS_DENIED');
    const scope = parseContract(ScopeSchema, JSON.parse(row.scope_json));
    this.authorizeScope(actor, scope, 'read'); this.materialGrant(actor, row.grant_id);
    const root = parseContract(MaterialRootSchema, JSON.parse(row.metadata).root);
    if (root.id !== rootId || root.grantId !== row.grant_id || !sameScope(root.scope, scope)) throw new ResearchError('BIO_ACCESS_DENIED');
    return root;
  }
  listMaterialRoots(actor: Actor, scope: ResearchScope, pageSize: number, cursor?: string) {
    this.authorizeScope(actor, scope, 'read');
    parseContract(z.number().int().min(1).max(200), pageSize); if (cursor) parseContract(IdSchema, cursor);
    const rows = this.query<{ id: string }, [string, string, number]>(
      'SELECT m.id FROM materials m JOIN root_grants r ON r.id=m.grant_id WHERE m.scope_key=? AND r.active=1 AND m.id>? ORDER BY m.id LIMIT ?',
    ).all(scopeKey(scope), cursor ?? '', pageSize + 1);
    return { items: rows.slice(0, pageSize).map(row => this.materialRoot(actor, row.id)),
      ...(rows.length > pageSize ? { nextCursor: rows[pageSize - 1]!.id } : {}) };
  }
  private updateDirectory(actor: Actor, rootId: string, input: MaterialDirectoryState, begin = false): void {
    const state = parseContract(MaterialDirectoryStateSchema, input);
    const material = this.materialRoot(actor, rootId);
    this.tx(actor, material.scope, 'material-index-state', rootId, current => {
      this.authorize(current, material.scope, 'read');
      const row = this.query<{ metadata: string }, [string]>('SELECT metadata FROM materials WHERE id=?').get(rootId)!;
      const metadata = JSON.parse(row.metadata), previous = metadata.directories[state.key];
      if (begin ? state.status !== 'indexing' || state.generation !== (previous?.generation ?? 0) + 1 :
        !previous || previous.generation !== state.generation || previous.status !== 'indexing' || previous.signature !== state.signature || previous.relativeDir !== state.relativeDir) {
        throw new ResearchError('BIO_REVISION_CONFLICT');
      }
      metadata.directories[state.key] = state;
      this.query('UPDATE materials SET metadata=? WHERE id=?').run(JSON.stringify(metadata), rootId);
    });
  }
  beginMaterialDirectory(actor: Actor, rootId: string, state: MaterialDirectoryState): void { this.updateDirectory(actor, rootId, state, true); }
  completeMaterialDirectory(actor: Actor, rootId: string, state: MaterialDirectoryState): void { this.updateDirectory(actor, rootId, state); }
  writeMaterialIndex(actor: Actor, rootId: string, state: MaterialDirectoryState, entries: IndexedMaterialEntry[]): void {
    parseContract(MaterialDirectoryStateSchema, state);
    const material = this.materialRoot(actor, rootId);
    if (entries.length > 200) throw new ResearchError('BIO_INPUT_INVALID');
    const currentState = this.materialDirectory(actor, rootId, state.key);
    if (currentState.generation !== state.generation || currentState.status !== 'indexing') throw new ResearchError('BIO_REVISION_CONFLICT');
    this.tx(actor, material.scope, 'material-index-batch', rootId, current => {
      this.authorize(current, material.scope, 'read');
      const stateNow = this.materialDirectory(current, rootId, state.key);
      if (stateNow.generation !== state.generation || stateNow.status !== 'indexing' || state.status !== 'indexing' || stateNow.signature !== state.signature ||
        stateNow.relativeDir !== state.relativeDir || state.count !== stateNow.count + entries.length) throw new ResearchError('BIO_REVISION_CONFLICT');
      for (const input of entries) {
        const entry = parseContract(IndexedMaterialEntrySchema, input);
        if (entry.directoryKey !== state.key) throw new ResearchError('BIO_INPUT_INVALID');
        this.query('INSERT INTO directory_index VALUES(?,?,?,?,?) ON CONFLICT(grant_id,id) DO UPDATE SET relative_path=excluded.relative_path,generation=excluded.generation,metadata=excluded.metadata')
          .run(material.grantId, entry.id, entry.relativePath, state.generation, JSON.stringify(entry));
      }
      const row = this.query<{ metadata: string }, [string]>('SELECT metadata FROM materials WHERE id=?').get(rootId)!;
      const metadata = JSON.parse(row.metadata); metadata.directories[state.key] = parseContract(MaterialDirectoryStateSchema, state);
      this.query('UPDATE materials SET metadata=? WHERE id=?').run(JSON.stringify(metadata), rootId);
    });
  }
  materialDirectory(actor: Actor, rootId: string, directoryKey: string): MaterialDirectoryState {
    this.materialRoot(actor, rootId);
    const row = this.query<{ metadata: string }, [string]>('SELECT metadata FROM materials WHERE id=?').get(rootId)!;
    const state = JSON.parse(row.metadata).directories[directoryKey];
    if (!state) throw new ResearchError('BIO_REVISION_CONFLICT');
    return parseContract(MaterialDirectoryStateSchema, state);
  }
  materialEntries(actor: Actor, rootId: string, directoryKey: string, generation: number, afterSort: string, afterId: string, limit: number): IndexedMaterialEntry[] {
    const material = this.materialRoot(actor, rootId), state = this.materialDirectory(actor, rootId, directoryKey);
    if (state.status !== 'complete' || state.generation !== generation) throw new ResearchError('BIO_REVISION_CONFLICT');
    parseContract(z.number().int().min(1).max(201), limit);
    return this.query<{ metadata: string }, [string, number, string, string, string, string, number]>(
      `SELECT metadata FROM directory_index WHERE grant_id=? AND generation=? AND json_extract(metadata,'$.directoryKey')=?
       AND (json_extract(metadata,'$.sortKey')>? OR (json_extract(metadata,'$.sortKey')=? AND id>?))
       ORDER BY json_extract(metadata,'$.sortKey'),id LIMIT ?`,
    ).all(material.grantId, generation, directoryKey, afterSort, afterSort, afterId, limit).map(row => parseContract(IndexedMaterialEntrySchema, JSON.parse(row.metadata)));
  }
  materialEntry(actor: Actor, rootId: string, directoryKey: string, generation: number, fileId: string): IndexedMaterialEntry {
    const material = this.materialRoot(actor, rootId), state = this.materialDirectory(actor, rootId, directoryKey);
    if (state.status !== 'complete' || state.generation !== generation) throw new ResearchError('BIO_REVISION_CONFLICT');
    parseContract(IdSchema, fileId);
    const row = this.query<{ metadata: string; generation: number }, [string, string]>('SELECT metadata,generation FROM directory_index WHERE grant_id=? AND id=?')
      .get(material.grantId, fileId);
    if (!row || row.generation !== generation) throw new ResearchError('BIO_ACCESS_DENIED');
    const entry = parseContract(IndexedMaterialEntrySchema, JSON.parse(row.metadata));
    if (entry.directoryKey !== directoryKey) throw new ResearchError('BIO_ACCESS_DENIED');
    return entry;
  }
  materialAnnotation(actor: Actor, rootId: string, directoryKey: string, generation: number, fileId: string): MaterialAnnotation {
    this.materialEntry(actor, rootId, directoryKey, generation, fileId);
    const row = this.query<{ metadata: string }, [string]>('SELECT metadata FROM materials WHERE id=?').get(rootId)!;
    return parseContract(MaterialAnnotationSchema, JSON.parse(row.metadata).annotations?.[fileId] ?? { fileId, revision: 0, note: '', tags: [], policy: 'restricted' });
  }
  saveMaterialAnnotation(actor: Actor, rootId: string, directoryKey: string, generation: number, input: MaterialAnnotation, expectedRevision: number): MaterialAnnotation {
    const root = this.materialRoot(actor, rootId), annotation = parseContract(MaterialAnnotationSchema, input);
    parseContract(GenerationSchema, expectedRevision);
    return this.tx(actor, root.scope, 'material-annotation-save', rootId, current => {
      this.authorize(current, root.scope, 'write');
      const previous = this.materialAnnotation(current, rootId, directoryKey, generation, annotation.fileId);
      if (previous.revision !== expectedRevision || annotation.revision !== expectedRevision + 1) throw new ResearchError('BIO_REVISION_CONFLICT');
      const row = this.query<{ metadata: string }, [string]>('SELECT metadata FROM materials WHERE id=?').get(rootId)!;
      const metadata = JSON.parse(row.metadata); metadata.annotations ??= {}; metadata.annotations[annotation.fileId] = annotation;
      this.query('UPDATE materials SET metadata=? WHERE id=?').run(JSON.stringify(metadata), rootId);
      return annotation;
    });
  }
  counts() {
    return { audit: this.query<{ count: number }, []>('SELECT count(*) AS count FROM audit').get()!.count,
      outbox: this.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!.count };
  }
}
