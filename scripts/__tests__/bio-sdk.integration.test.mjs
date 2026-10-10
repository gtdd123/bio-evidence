import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { assertInside, createLaunchSpec, readPinnedRuntime } from '../bio-launch.mjs';
import { buildNamespaceEnv, getSdkPaths } from '../../packages/shared/src/config/namespace.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('actual installed SDKs consume only owned default config and final spawn environment', () => {
  const fixtureParent = join(root, '.runtime', 'sdk-tests');
  mkdirSync(fixtureParent, { recursive: true });
  const fixture = mkdtempSync(join(fixtureParent, 'actual-'));
  const legacy = join(fixture, 'fake-legacy-home');
  mkdirSync(join(legacy, '.craft-agent'), { recursive: true });
  const sentinel = join(legacy, '.craft-agent', 'sentinel');
  writeFileSync(sentinel, 'unchanged synthetic sentinel');
  const parentEnv = { ...process.env };
  try {
    const spec = createLaunchSpec({
      projectRoot: root, executable: readPinnedRuntime(root), purpose: 'test',
      args: ['run', join(root, 'scripts', 'bio-sdk-probe.mjs')],
      baseEnv: { ...process.env, HOME: legacy, USERPROFILE: legacy,
        ANTHROPIC_API_KEY: 'synthetic-must-not-inherit', NODE_OPTIONS: '--inspect' },
    });
    const namespace = join(fixture, 'namespace');
    const env = buildNamespaceEnv({ ...spec.env, BIOEVIDENCE_CONFIG_DIR: namespace, CRAFT_CONFIG_DIR: namespace });
    const sdk = getSdkPaths(env);
    for (const directory of [namespace, sdk.home, sdk.claude, sdk.pi, env.TEMP, env.APPDATA, env.LOCALAPPDATA]) {
      mkdirSync(directory, { recursive: true });
    }
    const child = spawnSync(spec.executable, spec.args, {
      cwd: root, env, encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    assert.equal(child.status, 0, `SDK probe failed: ${child.stderr}\n${child.stdout}`);
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(Object.values(result).every(value => value === true), true);
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged synthetic sentinel');
    assert.equal(existsSync(join(legacy, '.claude.json')), false);
    // Compare plain copies and report only a boolean. Failed assertions must
    // never expand the host environment (which may contain credentials).
    assert.equal(isDeepStrictEqual({ ...process.env }, parentEnv), true, 'Parent environment changed');
  } finally {
    assertInside(fixtureParent, fixture, 'SDK fixture cleanup');
    assertInside(realpathSync(fixtureParent), realpathSync(fixture), 'SDK fixture cleanup');
    rmSync(fixture, { recursive: true, force: true });
  }
});
