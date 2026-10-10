import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertInside, createLaunchSpec, readPinnedRuntime } from '../bio-launch.mjs';
import { buildNamespaceEnv, getSdkPaths } from '../../packages/shared/src/config/namespace.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARKER = 'BIO_SYNTHETIC_BUILD_VALUE_';
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function artifacts(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap(item => item.isDirectory()
    ? artifacts(join(folder, item.name)) : [join(folder, item.name)]);
}
function fixture(t) {
  const parent = join(root, '.runtime', 'build-tests');
  mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, 'synthetic-'));
  t.after(() => {
    assertInside(parent, folder, 'Build fixture cleanup');
    assertInside(realpathSync(parent), realpathSync(folder), 'Build fixture cleanup');
    rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}
function run(folder, args) {
  const spec = createLaunchSpec({ projectRoot: root, executable: readPinnedRuntime(root), purpose: 'build', args });
  const namespace = join(folder, 'namespace');
  const env = buildNamespaceEnv({ ...spec.env, BIOEVIDENCE_CONFIG_DIR: namespace, CRAFT_CONFIG_DIR: namespace });
  for (const dir of [namespace, ...Object.values(getSdkPaths(env)), env.TEMP]) mkdirSync(dir, { recursive: true });
  // Only synthetic pressure inputs: real inherited business secrets were already
  // removed by createLaunchSpec. Values are not printed, even on test failure.
  for (const key of ['SLACK_OAUTH_CLIENT_SECRET', 'MICROSOFT_OAUTH_CLIENT_SECRET', 'OPENAI_API_KEY', 'SENTRY_ELECTRON_INGEST_URL', 'VITE_TOKEN']) {
    env[key] = `${MARKER}${key}`;
  }
  const child = spawnSync(spec.executable, spec.args, { cwd: folder, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (child.status !== 0) {
    console.log((child.stderr || '').replace(/BIO_SYNTHETIC_BUILD_VALUE_[A-Z_]+/g, '[synthetic]').slice(-2500));
  }
  return child;
}
function assertClean(folder) {
  const files = artifacts(folder);
  assert.ok(files.length > 0, 'Expected actual generated build artifacts');
  const hits = files.filter(path => readFileSync(path).includes(Buffer.from(MARKER))).map(path => path.slice(folder.length + 1));
  console.log(JSON.stringify({ generatedFiles: files.length, markerHitFiles: hits }));
  assert.equal(hits.length, 0, 'Synthetic secret marker entered actual build artifacts');
}

test('actual Electron main builder emits no synthetic secret or telemetry endpoint', t => {
  const folder = fixture(t);
  write(join(folder, 'package.json'), JSON.stringify({ type: 'module', scripts: {
    esbuild: `node "${join(root, 'node_modules/esbuild/bin/esbuild').replaceAll('\\', '/')}"`,
  } }));
  write(join(folder, 'bunfig.toml'), readFileSync(join(root, 'scripts/bunfig.bio-bootstrap.toml')));
  for (const name of ['electron-build-main.ts', 'bio-build.mjs', 'bio-launch.mjs', 'bunfig.bio-bootstrap.toml']) {
    const source = join(root, 'scripts', name);
    if (existsSync(source)) { mkdirSync(join(folder, 'scripts'), { recursive: true }); cpSync(source, join(folder, 'scripts', name)); }
  }
  const fields = ['SLACK_OAUTH_CLIENT_SECRET', 'MICROSOFT_OAUTH_CLIENT_SECRET', 'OPENAI_API_KEY', 'SENTRY_ELECTRON_INGEST_URL'];
  write(join(folder, '.env'), fields.map(key => `${key}=${MARKER}${key}`).join('\n'));
  write(join(folder, 'packages/session-tools-core/src/index.ts'), 'export const fixture = true;');
  write(join(folder, 'packages/session-mcp-server/src/index.ts'), 'export const fixture = true;');
  write(join(folder, 'packages/shared/src/unified-network-interceptor.ts'), 'export const fixture = true;');
  write(join(folder, 'packages/shared/src/config/namespace.mjs'), readFileSync(join(root, 'packages/shared/src/config/namespace.mjs')));
  write(join(folder, 'apps/electron/src/main/index.ts'), `export const pressure = [${fields.map(key => `process.env.${key}`).join(',')}];`);
  const child = run(folder, ['run', join(folder, 'scripts/electron-build-main.ts')]);
  assert.equal(child.status, 0, `Fixture builder failed (exit ${child.status}); no child payloads logged`);
  assertClean(join(folder, 'apps/electron/dist'));
});

for (const client of ['electron', 'webui']) {
  test(`actual Vite ${client} config does not expose inherited VITE credentials or dotenv values`, t => {
    const folder = fixture(t);
    write(join(folder, 'index.html'), '<html><body><script type="module" src="/probe.js"></script></body></html>');
    write(join(folder, 'probe.js'), 'document.body.dataset.probe = JSON.stringify([import.meta.env.VITE_TOKEN, import.meta.env.VITE_OTHER]);');
    write(join(folder, '.env'), `VITE_OTHER=${MARKER}DOTENV`);
    const configPath = join(root, `apps/${client}/vite.config.ts`).replaceAll('\\', '/');
    const output = join(folder, 'dist');
    // Real production environment policy, Vite engine and aliases. The tiny JS
    // fixture has no React/Babel needs, so UI plugins are not executed here;
    // full application builds are checked separately after this safety gate.
    write(join(folder, 'vite.config.ts'), `import base from ${JSON.stringify(configPath)}; export default { ...base, root: ${JSON.stringify(folder)}, plugins: [], build: { ...base.build, outDir: ${JSON.stringify(output)}, rollupOptions: { input: ${JSON.stringify(join(folder, 'index.html'))} } } };`);
    write(join(folder, 'vite-run.mjs'), `import { build } from ${JSON.stringify(join(root, 'node_modules/vite/dist/node/index.js').replaceAll('\\', '/'))}; await build({ configFile: ${JSON.stringify(join(folder, 'vite.config.ts'))} });`);
    const child = run(folder, ['run', join(folder, 'vite-run.mjs')]);
    assert.equal(child.status, 0, `Fixture Vite failed (exit ${child.status}); no child payloads logged`);
    assertClean(output);
  });
}
