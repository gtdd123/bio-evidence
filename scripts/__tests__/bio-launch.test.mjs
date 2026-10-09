import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertInside, createLaunchSpec, readPinnedRuntime, rejectAutoEnvFiles } from '../bio-launch.mjs';

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
  assert.equal(spec.env.HOME, undefined);
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
  const result = spawnSync(spec.executable, spec.args, { cwd: folder, env: spec.env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /neutral-ok/);
  assert.equal(existsSync(join(folder, 'unexpected-preload')), false);
});
