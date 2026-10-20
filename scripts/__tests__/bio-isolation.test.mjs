import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as actualFs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { test } from 'node:test';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fakeHome = path.join(root, '.runtime', 'fake-home');
const bioRoot = path.join(root, '.runtime', 'bio-test');
const bioEnv = { BIOEVIDENCE_MODE: '1', BIOEVIDENCE_CONFIG_DIR: bioRoot, CRAFT_CONFIG_DIR: bioRoot };

// No SDKs are imported. Default application fs/os calls use doubles; the
// explicit owned-junction regression injects only its real filesystem facade.
async function isolated(relativeFile, env = bioEnv, mocks = {}, observeCalls) {
  const calls = [];
  const files = new Map([[path.join(fakeHome, '.claude.json.backup'), 'old'], [path.join(fakeHome, '.claude.json.corrupted.fixture'), 'old']]);
  observeCalls?.(calls);
  const fs = {};
  for (const name of ['existsSync', 'readFileSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'appendFileSync', 'mkdirSync', 'statSync', 'lstatSync', 'readdirSync', 'rmSync', 'openSync', 'fsyncSync', 'closeSync']) {
    fs[name] = (...args) => {
      calls.push({ operation: name, path: String(args[0]), value: args[1] });
      if (name === 'existsSync') return files.has(String(args[0])) || path.parse(String(args[0])).root === String(args[0]);
      if (name === 'readFileSync') { if (!files.has(String(args[0]))) throw new Error('ENOENT'); return files.get(String(args[0])); }
      if (name === 'writeFileSync' || name === 'appendFileSync') files.set(String(args[0]), String(args[1]));
      if (name === 'mkdirSync') files.set(String(args[0]), '');
      if (name === 'unlinkSync') files.delete(String(args[0]));
      if (name === 'statSync') return { mtimeMs: 0, size: 0 };
      if (name === 'lstatSync') return { isSymbolicLink: () => false };
      if (name === 'readdirSync') return ['.claude.json.corrupted.fixture'];
    };
  }
  fs.realpathSync = Object.assign(value => value, { native: value => { calls.push({ operation: 'realpathSync', path: String(value) }); return String(value); } });
  const context = createContext({ process: { env: { ...env }, argv: ['node', '--debug'], platform: process.platform, versions: {}, cwd: () => root }, console, Buffer, Date, Map, Set, URL, TextEncoder, TextDecoder });
  const cache = new Map();
  async function moduleFor(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const source = readFileSync(filename, 'utf8');
    const code = filename.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'transform' }) : source;
    const mod = new SourceTextModule(code, { context, identifier: filename });
    cache.set(filename, mod);
    await mod.link(async (specifier, referencing) => {
      const key = specifier.replace(/^node:/, '');
      let values = mocks[specifier] ?? mocks[key];
      if (!values && key === 'fs') values = fs;
      if (!values && key === 'os') values = { homedir: () => fakeHome, hostname: () => 'fixture-host', userInfo: () => ({ username: 'fixture-user' }) };
      if (!values && key === 'path') values = path;
      if (!values && key === 'crypto') values = crypto;
      if (!values && specifier === '@craft-agent/shared/config/namespace') return moduleFor(path.join(root, 'packages/shared/src/config/namespace.mjs'));
      if (!values && /(?:namespace\.mjs|bio-desktop-env\.mjs|bio-runtime-guard\.mjs|config\/paths(?:\.ts)?)$/.test(specifier)) return moduleFor(path.resolve(path.dirname(referencing.identifier), specifier));
      if (!values) throw new Error(`Unprepared dependency denied: ${specifier}`);
      return new SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context });
    });
    return mod;
  }
  const mod = await moduleFor(path.join(root, relativeFile));
  await mod.evaluate();
  return { api: mod.namespace, calls, files, environment: context.process.env };
}

test('interceptor import/config/error use the Bio namespace and never touch fake old Craft root', async () => {
  const { api, calls } = await isolated('packages/shared/src/interceptor-common.ts');
  api.isRichToolDescriptionsEnabled();
  api.setStoredError({ status: 400, statusText: 'bad', message: 'synthetic-payload', timestamp: Date.now() });
  assert.equal(api.CONFIG_FILE, path.join(bioRoot, 'config.json'));
  assert.equal(api.LOG_DIR, path.join(bioRoot, 'logs'));
  assert.equal(calls.some(c => c.path.includes(`${path.sep}.craft-agent`)), false, JSON.stringify(calls));
  assert.equal(calls.some(c => c.path === path.join(bioRoot, 'api-error.json') && c.operation === 'writeFileSync'), true);
});

test('Bio interceptor missing namespace rejects before filesystem access', async () => {
  let observed;
  await assert.rejects(isolated('packages/shared/src/interceptor-common.ts', { BIOEVIDENCE_MODE: '1' }, {}, calls => observed = calls), /namespace|BIOEVIDENCE_CONFIG_DIR/);
  assert.deepEqual(observed, []);
});

test('Bio debug flag and raw payloads cannot write diagnostic logs', async () => {
  const { api, calls } = await isolated('packages/shared/src/interceptor-common.ts', { ...bioEnv, CRAFT_DEBUG: '1', CRAFT_DEBUG_SSE_RAW: '1' });
  api.debugLog('synthetic-request-secret', { Authorization: 'synthetic-secret', body: 'synthetic-private-body' });
  assert.equal(api.DEBUG, false);
  assert.equal(calls.filter(c => c.operation === 'appendFileSync').length, 0);
});

const optionMocks = { '../utils/debug': { debug: () => {} }, '../config/proxy-env.ts': { getProxyEnvVars: () => ({}) }, '../config/storage.ts': { getGitBashPath: () => undefined } };
test('Claude default options repair only owned SDK config and override external HOME', async () => {
  const { api, calls, files } = await isolated('packages/shared/src/agent/options.ts', { ...bioEnv, HOME: fakeHome, USERPROFILE: fakeHome }, optionMocks);
  const options = api.getDefaultOptions();
  assert.equal(calls.some(c => c.path === fakeHome || c.path.startsWith(fakeHome + path.sep)), false, JSON.stringify(calls));
  assert.equal(options.env.HOME, path.join(bioRoot, 'sdk', 'home'));
  assert.equal(options.env.CLAUDE_CONFIG_DIR, path.join(bioRoot, 'sdk', 'claude'));
  assert.equal(files.get(path.join(fakeHome, '.claude.json.backup')), 'old');
});

test('namespace rejects missing/relative/mismatched/legacy aliases without HOME or filesystem access', async () => {
  const { api } = await isolated('packages/shared/src/config/namespace.mjs');
  for (const env of [{ BIOEVIDENCE_MODE: '1' }, { BIOEVIDENCE_MODE: '1', BIOEVIDENCE_CONFIG_DIR: 'relative' }, { ...bioEnv, CRAFT_CONFIG_DIR: fakeHome }, { ...bioEnv, BIOEVIDENCE_CONFIG_DIR: path.join(fakeHome, '.craft-agent'), CRAFT_CONFIG_DIR: path.join(fakeHome, '.craft-agent') }]) {
    assert.throws(() => api.resolveConfigDir(env), /namespace/);
  }
  assert.equal(api.resolveConfigDir({ CRAFT_CONFIG_DIR: bioRoot }), bioRoot);
  assert.equal(api.resolveConfigDir({}), path.join(fakeHome, '.craft-agent'));
  assert.throws(() => api.validateNamespacePath(fakeHome), /namespace/);
});

test('SDK environment forces owned roots and preserves the parent while denying root override', async () => {
  const { api } = await isolated('packages/shared/src/config/namespace.mjs');
  const parent = { ...bioEnv, HOME: fakeHome, USERPROFILE: fakeHome, CODEX_HOME: 'unchanged', NODE_OPTIONS: '--require=untrusted', CRAFT_DEBUG: '1' };
  const copy = { ...parent };
  const env = api.buildNamespaceEnv(parent, { HOME: fakeHome, CLAUDE_CONFIG_DIR: fakeHome, PI_CODING_AGENT_DIR: fakeHome });
  assert.deepEqual(parent, copy);
  assert.equal(env.HOME, path.join(bioRoot, 'sdk', 'home'));
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(bioRoot, 'sdk', 'claude'));
  assert.equal(env.PI_CODING_AGENT_DIR, path.join(bioRoot, 'sdk', 'pi'));
  assert.equal(env.TEMP, path.join(bioRoot, 'tmp'));
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CRAFT_DEBUG, '0');
  for (const overrides of [{ BIOEVIDENCE_MODE: '0' }, { CRAFT_CONFIG_DIR: fakeHome }, { BIOEVIDENCE_CONFIG_DIR: fakeHome }, { CRAFT_SESSION_DIR: fakeHome }]) assert.throws(() => api.buildNamespaceEnv(parent, overrides), /BioEvidence/);
});

const sourceGuideMocks = { parseSourceGuide() {}, getSourceGuide() {}, getSourceGuideForDomain() {}, getSourceKnowledge() {}, extractDomainFromSource() {}, extractDomainFromUrl() {} };
const docMocks = { '../utils/paths.ts': { getBundledAssetsDir: () => null }, '../utils/debug.ts': { debug() {} }, './source-guides.ts': sourceGuideMocks, './doc-links.ts': { getDocUrl() {}, getDocInfo() {}, DOCS: {} } };
test('docs and release notes initialization write only the Bio root', async () => {
  for (const file of ['docs/index.ts', 'release-notes/index.ts']) {
    const { api, calls } = await isolated('packages/shared/src/' + file, bioEnv, docMocks);
    const initialize = file.startsWith('docs') ? api.initializeDocs : api.initializeReleaseNotes;
    initialize();
    assert.equal(calls.filter(c => c.operation === 'mkdirSync').every(c => c.path.startsWith(bioRoot + path.sep)), true);
    assert.equal(calls.some(c => c.path.includes('.craft-agent')), false);
  }
});

test('default workspace creation stays in the Bio root', async () => {
  const { api, calls } = await isolated('packages/shared/src/workspaces/storage.ts', bioEnv, {
    '../utils/paths.ts': { expandPath: x => x, toPortablePath: x => x }, '../utils/files.ts': { atomicWriteFileSync() {}, readJsonFileSync() {} },
    '../statuses/storage.ts': { getDefaultStatusConfig() {}, saveStatusConfig() {}, ensureDefaultIconFiles() {} }, '../labels/storage.ts': { getDefaultLabelConfig() {}, saveLabelConfig() {} },
    '../config/storage.ts': { loadConfigDefaults() {} }, '../agent/mode-types.ts': { parsePermissionMode() {}, PERMISSION_MODE_ORDER: [] }, '../agent/thinking-levels.ts': { normalizeThinkingLevel() {} },
  });
  api.ensureDefaultWorkspacesDir();
  assert.equal(api.getDefaultWorkspacesDir(), path.join(bioRoot, 'workspaces'));
  assert.equal(calls.some(c => c.operation === 'mkdirSync' && c.path === path.join(bioRoot, 'workspaces')), true);
});

test('window state persistence and dedicated Electron logs exclude old roots and payloads', async () => {
  const logger = { info() {}, warn() {}, error() {} };
  const { api, calls } = await isolated('apps/electron/src/main/window-state.ts', bioEnv, { './logger': { mainLog: logger }, '@craft-agent/shared/utils/files': { readJsonFileSync() {} } });
  api.saveWindowState({ windows: [] });
  assert.equal(calls.some(c => c.operation === 'writeFileSync' && c.path === path.join(bioRoot, 'window-state.json')), true);
  const log = { scope: () => logger, transports: { file: {}, console: {} } };
  const result = await isolated('apps/electron/src/main/logger.ts', bioEnv, { 'electron-log/main': { default: log } });
  result.api.messagingGatewayLog.info('synthetic-private-payload', { body: 'synthetic-secret' });
  result.api.autoUpdateLog.error('synthetic-private-payload', { Authorization: 'synthetic-secret' });
  const writes = result.calls.filter(c => c.operation === 'appendFileSync');
  assert.equal(writes.length, 2);
  assert.equal(writes.every(c => c.path.startsWith(bioRoot + path.sep) && !c.value.includes('synthetic')), true);
  assert.equal(result.api.isDebugMode, false);
});

test('secure credential backend only probes the Bio credential file', async () => {
  const { api, calls } = await isolated('packages/shared/src/credentials/backends/secure-storage.ts', bioEnv, {
    child_process: { execSync: () => { throw new Error('Hardware lookup denied in fake test'); } }, '../types.ts': { credentialIdToAccount: () => 'fixture', accountToCredentialId: () => null },
  });
  const backend = new api.SecureStorageBackend();
  assert.equal(await backend.get({ type: 'api_key' }), null);
  assert.equal(calls.some(c => c.operation === 'existsSync' && c.path === path.join(bioRoot, 'credentials.enc')), true);
  assert.equal(calls.some(c => c.path.includes('.craft-agent')), false);
});

test('stored errors redact response text and session overrides refuse outside state', async () => {
  const { api, calls } = await isolated('packages/shared/src/interceptor-common.ts');
  api.setStoredError({ status: 401, statusText: 'synthetic-header', message: 'synthetic-body', timestamp: Date.now() });
  const write = calls.find(c => c.operation === 'writeFileSync');
  assert.equal(write.value.includes('synthetic'), false);
  assert.throws(() => api.toolMetadataStore.setSessionDir(fakeHome), /namespace/);
  assert.throws(() => api.getLastApiError(fakeHome), /namespace/);
});

test('legacy bridge guard rejects Bio mode before generated bundle startup', async () => {
  const source = readFileSync(path.join(root, 'apps/electron/resources/bridge-mcp-server/index.js'), 'utf8');
  const guard = source.slice(source.indexOf('// BioEvidence:'), source.indexOf('var __create'));
  assert.match(guard, /Legacy bridge bundle is disabled/);
  const context = createContext({ process: { env: bioEnv } });
  const mod = new SourceTextModule(guard + '\nthrow new Error("startup reached");', { context });
  await mod.link(() => { throw new Error('No SDK imports allowed'); });
  await assert.rejects(mod.evaluate(), /Legacy bridge bundle is disabled/);
});

test('permission and browser prerequisites resolve inside namespace before IO', async () => {
  const common = { '../utils/debug.ts': { debug() {} }, '../utils/files.ts': { readJsonFileSync() {}, safeJsonParse() {} }, '../utils/paths.ts': { getBundledAssetsDir: () => null },
    '../sources/storage.ts': { getSourcePath() {} }, '../config/validators.ts': { isValidPermissionsFile: () => true }, '../feature-flags.ts': { FEATURE_FLAGS: {} }, './mode-types.ts': { SAFE_MODE_CONFIG: {}, PermissionsConfigSchema: {} } };
  const permission = await isolated('packages/shared/src/agent/permissions-config.ts', bioEnv, common);
  assert.equal(permission.api.getAppPermissionsDir(), path.join(bioRoot, 'permissions'));
  permission.api.ensureDefaultPermissions();
  assert.equal(permission.calls.some(c => c.path.includes('.craft-agent')), false);
  const prereq = await isolated('packages/shared/src/agent/core/prerequisite-manager.ts', bioEnv, { './path-processor.ts': { expandPath: x => x }, '../../config/storage.ts': { getBrowserToolEnabled: () => true } });
  const manager = new prereq.api.PrerequisiteManager({ workspaceRootPath: path.join(bioRoot, 'workspaces', 'fixture') });
  manager.checkPrerequisites('browser_tool');
  assert.equal(prereq.calls.some(c => c.path === path.join(bioRoot, 'docs', 'browser-tools.md')), true);
});

test('session config validation passes only Bio-owned app paths to the filesystem validator', async () => {
  const validated = [];
  const { api } = await isolated('packages/session-tools-core/src/handlers/config-validate.ts', bioEnv, {
    '../response.ts': { successResponse: x => x, errorResponse: x => x }, '../validation.ts': { formatValidationResult: () => 'ok', mergeResults() {}, validateJsonFileHasFields: p => { validated.push(p); return { valid: true }; } }, '../source-helpers.ts': { getSourceConfigPath() {} },
  });
  for (const target of ['config', 'preferences', 'tool-icons']) await api.handleConfigValidate({ workspacePath: path.join(bioRoot, 'workspaces', 'fixture') }, { target });
  assert.deepEqual(validated, [path.join(bioRoot, 'config.json'), path.join(bioRoot, 'preferences.json'), path.join(bioRoot, 'tool-icons', 'tool-icons.json')]);
});

test('logout deletes only the namespaced config and privileged audit omits commands', async () => {
  const removed = [];
  const registered = new Map();
  const channels = { auth: { LOGOUT: 'logout', SHOW_LOGOUT_CONFIRMATION: 'confirm', SHOW_DELETE_SESSION_CONFIRMATION: 'delete' }, credentials: { HEALTH_CHECK: 'health' } };
  const { api } = await isolated('packages/server-core/src/handlers/rpc/auth.ts', bioEnv, {
    'fs/promises': { unlink: async p => removed.push(p) }, '@craft-agent/shared/protocol': { RPC_CHANNELS: channels }, '@craft-agent/shared/credentials': { getCredentialManager: () => ({ list: async () => [], delete: async () => {} }) }, '@craft-agent/server-core/transport': { requestClientConfirmDialog() {} },
  });
  api.registerAuthHandlers({ handle: (key, fn) => registered.set(key, fn) }, { platform: { logger: { info() {}, error() {} } } });
  await registered.get('logout')();
  assert.deepEqual(removed, [path.join(bioRoot, 'config.json')]);
  const writes = [];
  const result = await isolated('packages/server-core/src/services/privileged-execution-broker.ts', bioEnv, { 'fs/promises': { mkdir: async () => {}, appendFile: async (p, value) => writes.push({ p, value }) } });
  const broker = new result.api.PrivilegedExecutionBroker({ warn() {} });
  broker.createRequest({ requestId: 'fixture', sessionId: 'fixture', command: 'echo synthetic-secret' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].p, path.join(bioRoot, 'logs', 'privileged-actions.jsonl'));
  assert.equal(writes[0].value.includes('synthetic'), false);
});

test('Pi normal and ephemeral options construct an explicit owned agentDir without importing SDK', async () => {
  const source = readFileSync(path.join(root, 'packages/pi-agent-server/src/index.ts'), 'utf8');
  for (const [name, end] of [['sessionOptions', '// Extension isolation:'], ['ephemeralOptions', 'const { session: ephemeralSession }']]) {
    const start = source.indexOf(`const ${name}: CreateAgentSessionOptions =`);
    assert.ok(start >= 0);
    const code = source.slice(start, source.indexOf(end, start));
    const { api: namespace } = await isolated('packages/shared/src/config/namespace.mjs');
    const context = createContext({ isBioEvidenceMode: () => true, getSdkPaths: () => namespace.getSdkPaths(), cwd: bioRoot, resolvedCwd: () => bioRoot, authStorage: {}, modelRegistry: {}, wrappedAll: [], toolAllowlist: [], piModel: {}, PiSessionManager: { inMemory: () => ({}) } });
    const mod = new SourceTextModule(stripTypeScriptTypes(code + `\nexport const observed = ${name};`, { mode: 'transform' }), { context });
    await mod.link(() => { throw new Error('SDK import denied'); });
    await mod.evaluate();
    assert.equal(mod.namespace.observed.agentDir, path.join(bioRoot, 'sdk', 'pi'));
  }
});

test('Electron bootstrap profiles are inside namespace and never mutate host HOME/CODEX_HOME', async () => {
  const { api: namespace } = await isolated('packages/shared/src/config/namespace.mjs');
  const env = namespace.buildNamespaceEnv({ ...bioEnv, HOME: fakeHome, CODEX_HOME: 'host-codex' });
  const original = { ...env };
  const profiles = [];
  const { calls, environment } = await isolated('apps/electron/src/main/bio-bootstrap.mjs', env, { electron: { app: { setName: () => {}, setPath: (name, directory) => profiles.push({ name, directory }) } } });
  assert.deepEqual({ ...env }, original); // Compare values across VM realms; caller is unchanged.
  assert.equal(environment.HOME, original.HOME);
  assert.equal(environment.CODEX_HOME, undefined); // Only the child copy is filtered.
  assert.equal(profiles.length, 3);
  assert.equal(profiles.every(p => p.directory.startsWith(bioRoot + path.sep)), true);
  assert.equal(calls.filter(c => ['mkdirSync', 'writeFileSync', 'appendFileSync'].includes(c.operation)).every(c => c.path === bioRoot || c.path.startsWith(bioRoot + path.sep)), true);
  assert.equal(calls.some(c => c.path === fakeHome || c.path.startsWith(fakeHome + path.sep)), false);
});

test('Electron bootstrap rejects a redirected appData ancestor before creating any product directory', async t => {
  const parent = path.join(root, '.runtime/bootstrap-boundary'); actualFs.mkdirSync(parent, { recursive: true });
  const fixture = actualFs.mkdtempSync(path.join(parent, 'owned-')), outside = path.join(fixture, 'outside'), link = path.join(fixture, 'appdata');
  actualFs.mkdirSync(outside); actualFs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => { const offset = path.relative(actualFs.realpathSync.native(parent), actualFs.realpathSync.native(fixture)); assert.ok(offset && offset !== '..' && !offset.startsWith('..' + path.sep) && !path.isAbsolute(offset)); actualFs.rmSync(fixture, { recursive: true, force: true }); });
  const fs = Object.fromEntries(['existsSync', 'lstatSync', 'mkdirSync', 'realpathSync'].map(name => [name, actualFs[name]]));
  await assert.rejects(isolated('apps/electron/src/main/bio-bootstrap.mjs', {}, { fs, electron: { app: { isPackaged: true, getPath: () => link, setName() {}, setPath() {} } } }), /symlink|redirect/);
  assert.equal(actualFs.existsSync(path.join(outside, 'BioEvidence')), false);
});
