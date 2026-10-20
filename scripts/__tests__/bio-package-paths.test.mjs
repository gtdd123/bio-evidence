import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createDeliveryDirectory } from '../bio-package-paths.mjs';
const parent = resolve('.runtime/package-path-tests'); mkdirSync(parent, { recursive: true });
function fixture(t) {
  const root = mkdtempSync(join(parent, 'owned-'));
  t.after(() => { const offset = relative(realpathSync.native(parent), realpathSync.native(root)); if (!offset || offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) throw Error('Test cleanup boundary'); rmSync(root, { recursive: true, force: true }); });
  return root;
}
test('delivery directories are fresh and limited to declared artifact kinds', t => {
  const root = fixture(t), first = createDeliveryDirectory(root, 'service'), second = createDeliveryDirectory(root, 'service');
  assert.notEqual(first, second); assert.equal(first.startsWith(join(root, '.runtime/build/deliveries') + sep), true);
  assert.throws(() => createDeliveryDirectory(root, '../outside'));
});
test('output setup refuses a redirected ancestor before creating any external output', t => {
  const root = fixture(t), project = join(root, 'project'), outside = join(root, 'outside'); mkdirSync(project); mkdirSync(outside);
  symlinkSync(outside, join(project, '.runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createDeliveryDirectory(project, 'desktop'), /symlink/);
  assert.equal(existsSync(join(outside, 'build')), false);
});

for (const redirected of ['.runtime', '.runtime/build']) {
  test(`real packaging launcher rejects redirected ${redirected} before any external write`, t => {
    const root = fixture(t), project = join(root, 'project'), outside = join(root, 'outside');
    for (const folder of ['scripts', 'packages/shared/src/config', '.tools']) mkdirSync(join(project, folder), { recursive: true });
    mkdirSync(outside);
    copyFileSync(resolve('scripts/bio-launch.mjs'), join(project, 'scripts/bio-launch.mjs'));
    copyFileSync(resolve('packages/shared/src/config/namespace.mjs'), join(project, 'packages/shared/src/config/namespace.mjs'));
    // The preflight must reject before even probing Bun or loading the packager.
    writeFileSync(join(project, '.tools/fake-bun.exe'), 'not executable');
    writeFileSync(join(project, '.tools/bun-manifest.json'), JSON.stringify({ version: '1.3.10', executable: '.tools/fake-bun.exe' }));
    if (redirected.includes('/')) mkdirSync(join(project, '.runtime'));
    symlinkSync(outside, join(project, redirected), process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, ['scripts/bio-launch.mjs', 'build', 'run', 'scripts/bio-server-package.ts'], { cwd: project, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1);
    assert.deepEqual(readdirSync(outside), [], 'No runtime, cache or SDK directory may be created through the redirect');
    assert.match(result.stderr, /symlink|redirect/);
  });
}
