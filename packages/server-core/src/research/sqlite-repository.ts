// Bun-only adapter. Do not export it from server-core's Node/Electron entry.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import { mkdirSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  ActorSchema, ScopeSchema, IdSchema, GenerationSchema, SourceSchema, SnapshotSchema,
  EvidenceRevisionSchema, ReportRevisionSchema, SessionSchema, RunSchema, ResearchError,
  parseContract, assertScopeAccess, assertSessionControl, sameScope, assertSnapshotSource, validateCitation,
  mergeSessionPolicy, transitionRun, RunStateSchema,
  type Actor, type ResearchScope, type ResearchEntity, type ResearchEntityKind,
  type ResearchRepository, type AuthorityUser, type JsonValue, type ProjectionEntry, type ResearchRun, type RunState,
  type EvidenceRevision, type ReportRevision, type AuthorityAuthSession,
} from '@bio-evidence/research-core';
import { resolveConfigDir, validateNamespacePath } from '@craft-agent/shared/config/namespace';
import { INITIAL_SCHEMA, SCHEMA_VERSION } from './schema.ts';

const Schemas = { source: SourceSchema, snapshot: SnapshotSchema, evidence: EvidenceRevisionSchema,
  report: ReportRevisionSchema, session: SessionSchema, run: RunSchema } as const;
const KindSchema = z.enum(['source', 'snapshot', 'evidence', 'report', 'session', 'run']);
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
  private tx<T>(input: Actor, scope: ResearchScope | null, action: string, id: string | null, work: (actor: Actor) => T): T {
    const actor = parseContract(ActorSchema, input);
    try {
      return this.db.transaction(() => {
        this.assertWriter();
        const result = work(this.currentActor(actor));
        this.audit(actor.userId, scope, action, 'success', id);
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
      if (review) Object.assign(payload, { reviewStatus: review.decision, review: {
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
      const entityId = kind === 'evidence' ? (value as z.infer<typeof EvidenceRevisionSchema>).evidenceId :
        kind === 'report' ? (value as z.infer<typeof ReportRevisionSchema>).reportId : value.id;
      const head = this.query<HeadRow, [string, string]>('SELECT revision,record_id,policy FROM heads WHERE kind=? AND entity_id=?').get(kind, entityId);
      if ((head?.revision ?? 0) !== expectedRevision) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (head && !sameScope(this.binding(kind, head.record_id), value.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
      if ('policy' in value && head?.policy && mergeSessionPolicy(head.policy, [value.policy]) !== value.policy) throw new ResearchError('BIO_POLICY_DENIED');
      if ('revision' in value && value.revision !== expectedRevision + 1) throw new ResearchError('BIO_REVISION_CONFLICT');
      if (kind === 'snapshot') {
        if (head) throw new ResearchError('BIO_REVISION_CONFLICT');
        const snapshot = value as z.infer<typeof SnapshotSchema>;
        assertSnapshotSource(snapshot, this.get(current, 'source', snapshot.sourceId));
      }
      if (kind === 'session') {
        const session = value as z.infer<typeof SessionSchema>;
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
          if (evidence.structuralStatus === 'structure-valid' && validateCitation(snapshot, ref).status !== 'structure-valid') throw new ResearchError('BIO_INPUT_INVALID');
        }
      }
      if (kind === 'report') for (const id of (value as z.infer<typeof ReportRevisionSchema>).evidenceRevisionIds) {
        const evidence = parseContract(EvidenceRevisionSchema, this.get(current, 'evidence', id));
        if (!sameScope(evidence.scope, value.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
        if ('structuralStatus' in value && value.structuralStatus === 'structure-valid' && evidence.structuralStatus !== 'structure-valid') throw new ResearchError('BIO_INPUT_INVALID');
      }
      if (('review' in value && value.review && value.review.reviewerId !== current.userId) ||
          ('authorId' in value && value.authorId !== current.userId)) throw new ResearchError('BIO_ACCESS_DENIED');
      const oldBinding = this.query<{ scope_key: string }, [string, string]>('SELECT scope_key FROM bindings WHERE kind=? AND id=?').get(kind, value.id);
      if (oldBinding && oldBinding.scope_key !== scopeKey(value.scope)) throw new ResearchError('BIO_ACCESS_DENIED');
      if (oldBinding && ['snapshot', 'evidence', 'report'].includes(kind)) throw new ResearchError('BIO_REVISION_CONFLICT');
      this.query('INSERT INTO bindings VALUES(?,?,?) ON CONFLICT(kind,id) DO NOTHING').run(kind, value.id, scopeKey(value.scope));
      this.query('INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload')
        .run(kind, value.id, scopeKey(value.scope), JSON.stringify(value));
      this.query('INSERT INTO heads VALUES(?,?,?,?,?) ON CONFLICT(kind,entity_id) DO UPDATE SET record_id=excluded.record_id,revision=excluded.revision,policy=excluded.policy')
        .run(kind, entityId, value.id, expectedRevision + 1, 'policy' in value ? value.policy : null);
      if (kind === 'snapshot') for (const block of (value as z.infer<typeof SnapshotSchema>).blocks) {
        this.query('INSERT INTO snapshot_blocks VALUES(?,?,?,?,?)').run(value.id, block.id, block.unit, block.text, JSON.stringify(block.locator));
      }
      if (kind === 'run') {
        this.query('DELETE FROM run_leases WHERE run_id=?').run(value.id);
        const lease = (value as ResearchRun).lease;
        if (lease) this.query('INSERT INTO run_leases VALUES(?,?,?,?)').run(value.id, lease.workerId, lease.generation, lease.expiresAt);
      }
      this.event(value.scope, kind, value.id, expectedRevision + 1);
      return value;
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
      const next = parseContract((kind === 'evidence' ? EvidenceRevisionSchema : ReportRevisionSchema) as z.ZodType<EvidenceRevision | ReportRevision>, {
        ...value, reviewStatus: decision, review: { reviewerId: current.userId, reviewedAt: now, revisionId: id, revisionNumber: expectedRevision },
      });
      this.query('INSERT INTO reviews VALUES(?,?,?,?,?,?) ON CONFLICT(kind,record_id) DO UPDATE SET decision=excluded.decision,reviewer_id=excluded.reviewer_id,reviewed_at=excluded.reviewed_at,revision=excluded.revision')
        .run(kind, id, decision, current.userId, now, expectedRevision);
      this.event(scope, 'human-review', id, expectedRevision);
      return next;
    });
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
  counts() {
    return { audit: this.query<{ count: number }, []>('SELECT count(*) AS count FROM audit').get()!.count,
      outbox: this.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!.count };
  }
}
