import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, symlinkSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';
import { resolveConfigDir, buildNamespaceEnv } from '@craft-agent/shared/config/namespace';
import { SqliteResearchRepository } from './sqlite-repository.ts';

const actor = { userId: 'alice', authSessionId: 'auth-a', active: true, administrator: false };
const scope = { kind: 'personal', ownerId: 'alice' };
describe('SQLite persistence and service authority', () => {
  let root: string;
  let filename: string;
  let repo: SqliteResearchRepository | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(resolveConfigDir(), 't04-store-'));
    filename = join(root, 'metadata.sqlite');
  });
  afterEach(() => {
    repo?.close(); repo = undefined;
    const base = realpathSync.native(resolveConfigDir());
    const target = realpathSync.native(root);
    const offset = relative(base, target);
    if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error('Owned cleanup boundary violated');
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  function initialize() {
    repo = new SqliteResearchRepository(filename);
    repo.seedUser({ id: 'alice', username: 'alice', passwordHash: 'synthetic-hash', active: true, administrator: false, revision: 1 });
    repo.put(actor, 'session', { id: 'research-a', ownerId: 'alice', scope, policy: 'restricted', name: 'Local', revision: 1, createdAt: 1 });
  }
  test('restart retains full messages and creates a pre-migration backup', () => {
    initialize();
    const messages = [{ id: 'message-a', role: 'assistant', content: 'Full persisted output', timestamp: 1,
      toolInput: { values: [1, 2] }, annotations: [{ text: 'preserved' }], turnId: 'turn-a' }];
    repo!.appendProjection(actor, 'research-a', 'operation-a', messages, 1);
    repo!.close();
    repo = new SqliteResearchRepository(filename);
    expect(repo.readProjection(actor, 'research-a')[0]?.messages).toEqual(messages);
    expect(repo.getUserForAuth('alice')?.active).toBe(true);
    expect(readdirSync(root).some(name => name.startsWith('metadata.sqlite.backup-v0-'))).toBe(true);
  });
  test('live second writer is refused including a directory junction alias', () => {
    initialize();
    expect(() => new SqliteResearchRepository(filename)).toThrow();
    const alias = join(root, 'alias');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => new SqliteResearchRepository(join(alias, 'metadata.sqlite'))).toThrow();
    expect(repo!.getUserForAuth('alice')?.active).toBe(true);
  });
  test('unrecognized database and newer migration are refused without data deletion', () => {
    const db = new Database(filename);
    db.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('preserve');");
    db.close();
    expect(() => new SqliteResearchRepository(filename)).toThrow();
    const inspection = new Database(filename);
    const statement = inspection.prepare<{ value: string }, []>('SELECT value FROM legacy');
    try { expect(statement.get()?.value).toBe('preserve'); } finally { statement.finalize(); }
    inspection.exec('PRAGMA user_version=999;'); inspection.close();
    expect(() => new SqliteResearchRepository(filename)).toThrow();
  });
  test('a killed owned service permits safe PID-checked SQLite takeover', async () => {
    initialize(); repo!.close(); repo = undefined;
    const fixture = join(root, 'owned-crash-child.ts');
    const moduleUrl = pathToFileURL(resolve(import.meta.dir, 'sqlite-repository.ts')).href;
    writeFileSync(fixture, `const { SqliteResearchRepository } = await import(${JSON.stringify(moduleUrl)});\n` +
      `const repo = new SqliteResearchRepository(${JSON.stringify(filename)});\n` +
      `console.log('READY');\nawait new Promise(() => {});\n`);
    const child = Bun.spawn([process.execPath, 'run', `--config=${resolve('scripts/bunfig.bio-bootstrap.toml')}`, fixture], {
      cwd: resolve('.'), env: buildNamespaceEnv(process.env), stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const reader = child.stdout.getReader();
      const ready = await Promise.race([reader.read(), Bun.sleep(10000).then(() => { throw new Error('Owned child did not become ready'); })]);
      const childError = ready.done ? await new Response(child.stderr).text() : '';
      expect(new TextDecoder().decode(ready.value), childError).toContain('READY');
      expect(() => new SqliteResearchRepository(filename)).toThrow();
      child.kill('SIGKILL'); await child.exited;
      repo = new SqliteResearchRepository(filename);
      expect(repo.get(actor, 'session', 'research-a')).toMatchObject({ ownerId: 'alice', policy: 'restricted' });
    } finally {
      child.kill('SIGKILL'); await child.exited;
    }
  }, 20000);
});
