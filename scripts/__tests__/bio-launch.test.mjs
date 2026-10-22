import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { assertInside, createLaunchSpec, readPinnedRuntime, rejectAutoEnvFiles } from '../bio-launch.mjs';
import { buildNamespaceEnv } from '../../packages/shared/src/config/namespace.mjs';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixtureParent = join(projectRoot, '.runtime', 'launcher-tests');
mkdirSync(fixtureParent, { recursive: true });

function fixture(t) {
  const folder = mkdtempSync(join(fixtureParent, 'case-'));
  t.after(() => {
    assertInside(fixtureParent, folder, 'Owned test fixture cleanup');
    assertInside(realpathSync(fixtureParent), realpathSync(folder), 'Resolved test fixture cleanup');
    rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

test('launch environment excludes inherited credentials without mutating the parent', () => {
  const parent = { PATH: 'system-path', OPENAI_API_KEY: 'synthetic-secret', SLACK_OAUTH_CLIENT_SECRET: 'synthetic-secret', HOME: 'unchanged-home', CODEX_HOME: 'unchanged-codex' };
  const copy = { ...parent };
  const spec = createLaunchSpec({ projectRoot, executable: join(projectRoot, '.tools', 'fake-bun.exe'), purpose: 'test', args: ['test'], baseEnv: parent });
  assert.equal(spec.env.OPENAI_API_KEY, undefined);
  assert.equal(spec.env.SLACK_OAUTH_CLIENT_SECRET, undefined);
  assert.equal(spec.env.HOME, join(projectRoot, '.runtime', 'test', 'sdk', 'home'));
  assert.equal(spec.env.USERPROFILE, spec.env.HOME);
  assert.equal(spec.env.CODEX_HOME, undefined);
  assert.equal(spec.env.CRAFT_CONFIG_DIR, join(projectRoot, '.runtime', 'test'));
  assert.deepEqual(parent, copy);
});

test('callers cannot change cwd, preload, config, env-file, or use a global runtime', () => {
  for (const flag of ['--cwd=elsewhere', '--preload=unsafe.ts', '--require=unsafe.ts', '--import', '--import=unsafe.ts', '--config=unsafe.toml', '--env-file=secrets', '-c', '-c=unsafe.toml', '-r', '-d']) {
    assert.throws(() => createLaunchSpec({ projectRoot, executable: join(projectRoot, '.tools', 'fake-bun.exe'), purpose: 'test', args: ['test', flag] }));
  }
  assert.throws(() => createLaunchSpec({ projectRoot, executable: join(projectRoot, '..', 'global-bun.exe'), purpose: 'test', args: ['test'] }));
});

test('auto-loaded dotenv files are rejected by name without loading their values', (t) => {
  const folder = fixture(t);
  writeFileSync(join(folder, '.env.example'), 'placeholder only');
  rejectAutoEnvFiles(folder);
  writeFileSync(join(folder, '.env.test'), 'synthetic value');
  assert.throws(() => rejectAutoEnvFiles(folder), /Automatic \.env/);
});

test('fixed Bun honors neutral config and does not execute a default preload', (t) => {
  const folder = fixture(t);
  const executable = readPinnedRuntime(projectRoot);
  writeFileSync(join(folder, 'bunfig.toml'), 'preload = ["./sentinel.ts"]\n');
  writeFileSync(join(folder, 'sentinel.ts'), 'import {writeFileSync} from "node:fs";writeFileSync("unexpected-preload", "ran");');
  writeFileSync(join(folder, 'probe.ts'), 'if(process.env.OPENAI_API_KEY)throw new Error("inherited secret");if(!process.env.CRAFT_CONFIG_DIR)throw new Error("missing namespace");console.log("neutral-ok");');
  const spec = createLaunchSpec({ projectRoot, executable, purpose: 'bootstrap', args: ['run', join(folder, 'probe.ts')], baseEnv: { PATH: process.env.PATH || process.env.Path || '', OPENAI_API_KEY: 'synthetic-secret' } });
  for (const dir of [spec.env.HOME, spec.env.CLAUDE_CONFIG_DIR, spec.env.PI_CODING_AGENT_DIR, spec.env.TEMP]) mkdirSync(dir, { recursive: true });
  const result = spawnSync(spec.executable, spec.args, { cwd: folder, env: spec.env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /neutral-ok/);
  assert.equal(existsSync(join(folder, 'unexpected-preload')), false);
});

test('install-purpose namespace/SDK env and neutral probe leave the fake old HOME sentinels unchanged', (t) => {
  const folder = fixture(t);
  const fakeHome = join(folder, 'old-home');
  mkdirSync(join(fakeHome, '.craft-agent', 'logs'), { recursive: true });
  const sentinels = [join(fakeHome, '.craft-agent', 'logs', 'interceptor.log'), join(fakeHome, '.claude.json.backup'), join(fakeHome, '.claude.json.corrupted.fixture')];
  for (const file of sentinels) writeFileSync(file, 'owned-old-sentinel');
  const before = sentinels.map(file => ({ content: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs }));
  const parent = { PATH: process.env.PATH || process.env.Path || '', HOME: fakeHome, USERPROFILE: fakeHome, CODEX_HOME: 'unchanged-codex', OPENAI_API_KEY: 'synthetic-key', NODE_OPTIONS: '--require=untrusted', CRAFT_DEBUG: '1', CRAFT_DEBUG_SSE_RAW: '1' };
  const original = { ...parent };
  const executable = readPinnedRuntime(projectRoot);
  const install = createLaunchSpec({ projectRoot, executable, purpose: 'install', args: ['install', '--frozen-lockfile'], baseEnv: parent });
  assert.equal(install.env.BIOEVIDENCE_CONFIG_DIR, join(projectRoot, '.runtime', 'install'));
  assert.equal(install.env.CRAFT_CONFIG_DIR, install.env.BIOEVIDENCE_CONFIG_DIR);
  assert.equal(install.env.OPENAI_API_KEY, undefined);
  assert.equal(install.env.NODE_OPTIONS, undefined);
  assert.equal(install.env.CODEX_HOME, undefined);
  assert.equal(install.env.CRAFT_DEBUG_SSE_RAW, '0');
  const resolverUrl = pathToFileURL(join(projectRoot, 'packages/shared/src/config/namespace.mjs')).href;
  const probe = join(folder, 'install-probe.mjs');
  writeFileSync(probe, `import {resolveConfigDir,getSdkPaths} from ${JSON.stringify(resolverUrl)}; import {homedir} from 'node:os'; if(resolveConfigDir()!==process.env.CRAFT_CONFIG_DIR)throw Error('alias mismatch');if(homedir()!==getSdkPaths().home)throw Error('SDK home mismatch');console.log('install-neutral-ok');`);
  const spec = createLaunchSpec({ projectRoot, executable, purpose: 'install', args: ['run', probe], baseEnv: parent });
  for (const dir of [spec.env.HOME, spec.env.CLAUDE_CONFIG_DIR, spec.env.PI_CODING_AGENT_DIR, spec.env.TEMP]) mkdirSync(dir, { recursive: true });
  const result = spawnSync(spec.executable, spec.args, { cwd: folder, env: spec.env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /install-neutral-ok/);
  assert.deepEqual(parent, original);
  assert.deepEqual(sentinels.map(file => ({ content: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs })), before);
});

test('missing Bio namespace pure subprocess fails before application/SDK imports', (t) => {
  const folder = fixture(t);
  const executable = readPinnedRuntime(projectRoot);
  const spec = createLaunchSpec({ projectRoot, executable, purpose: 'bootstrap', args: ['--version'] });
  const env = { ...spec.env };
  delete env.BIOEVIDENCE_CONFIG_DIR;
  delete env.CRAFT_CONFIG_DIR;
  const resolverUrl = pathToFileURL(join(projectRoot, 'packages/shared/src/config/namespace.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {resolveConfigDir} from ${JSON.stringify(resolverUrl)};resolveConfigDir();`], { cwd: folder, env, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /BioEvidence namespace requires/);
});

test('mixed-case restricted SDK environment keys are removed without changing parent or overrides', () => {
  const stateRoot = join(projectRoot, '.runtime', 'case-env');
  const parent = { BIOEVIDENCE_MODE: '1', BIOEVIDENCE_CONFIG_DIR: stateRoot, CRAFT_CONFIG_DIR: stateRoot, Node_Options: 'synthetic-hook', bun_options: 'synthetic-hook', Claude_Code_Debug: '1', Debug: 'synthetic-payload' };
  const overrides = { nOdE_oPtIoNs: 'synthetic-hook', bUn_OpTiOnS: 'synthetic-hook', cLaUdE_cOdE_dEbUg: '1', dEbUg: 'synthetic-payload' };
  const original = { ...parent };
  const originalOverrides = { ...overrides };
  const env = buildNamespaceEnv(parent, overrides);
  assert.deepEqual(parent, original);
  assert.deepEqual(overrides, originalOverrides);
  assert.deepEqual(Object.keys(env).filter(key => /^(NODE_OPTIONS|BUN_OPTIONS|CLAUDE_CODE_DEBUG|DEBUG)$/i.test(key)), []);
});

test('mixed-case Node_Options cannot preload an owned synthetic hook in a real Node subprocess', (t) => {
  const folder = fixture(t);
  const stateRoot = join(folder, 'namespace');
  const marker = join(folder, 'hook-entered');
  const hook = join(folder, 'synthetic-hook.cjs');
  writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'synthetic-hook-entered'); process.exit(9);`);
  const parent = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH || process.env.Path || '', BIOEVIDENCE_MODE: '1', BIOEVIDENCE_CONFIG_DIR: stateRoot, CRAFT_CONFIG_DIR: stateRoot, Node_Options: `--require="${hook.replaceAll('\\', '/')}"` };
  const original = { ...parent };
  const env = buildNamespaceEnv(parent);
  for (const dir of [env.HOME, env.CLAUDE_CONFIG_DIR, env.PI_CODING_AGENT_DIR, env.TEMP]) mkdirSync(dir, { recursive: true });
  const child = spawnSync(process.execPath, ['-e', 'console.log("safe-child-entered")'], { cwd: folder, env, encoding: 'utf8', windowsHide: true });
  assert.deepEqual(parent, original);
  assert.equal(child.status, 0, `child status=${child.status}; owned hook marker=${existsSync(marker)}; ${child.stderr}`);
  assert.match(child.stdout, /safe-child-entered/);
  assert.equal(existsSync(marker), false);
});

test('only runtime admits named model settings; only the explicit demo boolean enters builds', () => {
  const baseEnv = { OPENAI_API_KEY: 'synthetic-openai', DEEPSEEK_API_KEY: 'synthetic-deepseek', OPENAI_API_BASE_URL: 'https://gateway.example/v1', VITE_DEMO_MODE: 'true', VITE_SECRET: 'never-build' };
  const spec = purpose => createLaunchSpec({ projectRoot, executable: join(projectRoot, '.tools', 'fake-bun.exe'), purpose, args: ['run','probe.ts'], baseEnv });
  assert.equal(spec('runtime').env.DEEPSEEK_API_KEY, 'synthetic-deepseek');
  for(const purpose of ['test','build','bootstrap','install']) { assert.equal(spec(purpose).env.OPENAI_API_KEY, undefined); assert.equal(spec(purpose).env.DEEPSEEK_API_KEY, undefined); assert.equal(spec(purpose).env.VITE_SECRET, undefined); }
  assert.equal(spec('build').env.VITE_DEMO_MODE, 'true'); assert.equal(spec('test').env.VITE_DEMO_MODE, undefined);
});
