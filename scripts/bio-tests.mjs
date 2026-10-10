import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLaunchSpec, launch, readPinnedRuntime } from './bio-launch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selected = process.argv.slice(2);
if (selected.some(item => !['--node', '--regular', '--isolated'].includes(item))) throw new Error('Unknown test selection');
const enabled = part => selected.length === 0 || selected.includes(`--${part}`);
const excluded = new Set(['node_modules', '.git', '.runtime', '.tools', 'dist', 'release']);
function find(folder, suffix) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(item => {
    if (item.isDirectory()) return excluded.has(item.name) ? [] : find(join(folder, item.name), suffix);
    return item.name.endsWith(suffix) ? [join(folder, item.name)] : [];
  }).sort();
}
let failed = false;
function record(part, status) { console.log(JSON.stringify({ part, exitCode: status })); if (status !== 0) failed = true; }
if (enabled('node')) {
  const spec = createLaunchSpec({ projectRoot: root, executable: readPinnedRuntime(root), purpose: 'test', args: ['test'] });
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', ...find(join(root, 'scripts/__tests__'), '.test.mjs')], {
    cwd: root, env: spec.env, stdio: 'inherit', windowsHide: true,
  });
  record('node', child.status ?? 1);
}
if (enabled('regular')) record('regular', launch({ purpose: 'test', args: ['test', 'packages', 'apps'] }));
if (enabled('isolated')) {
  const files = [...find(join(root, 'packages'), '.isolated.ts'), ...find(join(root, 'apps'), '.isolated.ts')].sort();
  for (const file of files) record(file.slice(root.length + 1), launch({ purpose: 'test', args: ['test', file] }));
}
process.exitCode = failed ? 1 : 0;
