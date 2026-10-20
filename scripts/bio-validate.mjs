import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['scripts/bio-tests.mjs', '--node']);
const serviceTests = readdirSync(join(root, 'packages/server/src')).filter(name => /^bio-.*\.test\.ts$/.test(name) || name === 'owned-shutdown.test.ts').map(name => 'packages/server/src/' + name);
run(['scripts/bio-launch.mjs', 'test', 'test', 'packages/research-core/src', 'packages/server-core/src/research', 'packages/shared/src/protocol/__tests__/research.test.ts', ...serviceTests]);
run(['scripts/bio-launch.mjs', 'bootstrap', 'run', 'typecheck:all']);
run(['scripts/bio-launch.mjs', 'bootstrap', 'run', 'tsc', '--noEmit', '-p', 'apps/webui/tsconfig.json']);
run(['scripts/bio-launch.mjs', 'build', 'run', 'scripts/bio-renderer-build.ts', 'web']);
run(['scripts/bio-launch.mjs', 'build', 'run', 'scripts/bio-electron-build.ts']);
run(['scripts/bio-launch.mjs', 'build', 'run', 'scripts/bio-renderer-build.ts', 'desktop']);
run(['scripts/bio-launch.mjs', 'test', 'run', 'packages/server/src/bio-resources.ts']);
console.log('BioEvidence validation completed.');
