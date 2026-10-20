import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { createBioDesktopEnv } from '../../apps/electron/src/main/bio-desktop-env.mjs';
import { buildNamespaceEnv } from '../../packages/shared/src/config/namespace.mjs';

test('standalone package starts only in its distinct product namespace and strips provider/hook environment', () => {
  const appData = resolve('synthetic-appdata'), env = createBioDesktopEnv({ OPENAI_API_KEY: 'synthetic-key', CRAFT_CONFIG_DIR: resolve('.craft-agent'), NODE_OPTIONS: '--require unwanted', PATH: 'synthetic-path' }, { packaged: true, appData });
  assert.equal(env.BIOEVIDENCE_CONFIG_DIR, join(appData, 'BioEvidence'));
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HOME, join(appData, 'BioEvidence/sdk/home'));
});
test('source launch still requires the complete existing isolated namespace and rejects mixed aliases', () => {
  assert.throws(() => createBioDesktopEnv({}, { packaged: false, appData: resolve('.') }));
  const root = resolve('.runtime/test/synthetic-desktop'), base = buildNamespaceEnv({ BIOEVIDENCE_MODE: '1', BIOEVIDENCE_CONFIG_DIR: root, CRAFT_CONFIG_DIR: root });
  assert.equal(createBioDesktopEnv(base, { packaged: false, appData: resolve('.') }).BIOEVIDENCE_CONFIG_DIR, root);
  assert.throws(() => createBioDesktopEnv({ ...base, HOME: resolve('.') }, { packaged: true, appData: resolve('.') }));
  assert.throws(() => createBioDesktopEnv({ ...base, CRAFT_CONFIG_DIR: resolve('.craft-agent') }, { packaged: true, appData: resolve('.') }));
});
