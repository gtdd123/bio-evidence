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
const researchTests = [
  'packages/research-core/src', 'packages/server-core/src/research',
  'packages/server-core/src/transport/__tests__/user-session-url.test.ts',
  'packages/shared/src/auth/__tests__/bio-client.test.ts',
  'packages/shared/src/protocol/__tests__', 'packages/shared/src/i18n/__tests__',
  'packages/shared/src/agent/backend/__tests__/public-research.test.ts',
  'packages/shared/src/credentials/backends/secure-storage-atomic.test.ts',
  'packages/shared/src/sessions/__tests__/persistence-durability.test.ts',
  'packages/shared/src/sessions/__tests__/persistence-queue.test.ts',
  'apps/electron/src/renderer/bio', 'apps/electron/src/main/bio-window-access.test.ts',
  'apps/electron/src/transport/bio-client.test.ts', 'apps/electron/src/transport/bio-api.test.ts',
  'apps/electron/src/transport/bio-http.test.ts',
];
run(['scripts/bio-launch.mjs', 'test', 'test', ...researchTests, ...serviceTests]);
run(['scripts/bio-launch.mjs', 'bootstrap', 'run', 'typecheck:all']);
run(['scripts/bio-launch.mjs', 'bootstrap', 'run', 'tsc', '--noEmit', '-p', 'packages/research-core/tsconfig.json']);
run(['scripts/bio-launch.mjs', 'bootstrap', 'run', 'tsc', '--noEmit', '-p', 'apps/webui/tsconfig.json']);
run(['scripts/bio-launch.mjs', 'bootstrap', 'run', 'tsc', '--noEmit', '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'esnext', '--types', 'bun,node', '--allowJs', '--esModuleInterop', '--skipLibCheck', '--strict', 'scripts/bio-desktop-package.ts', 'scripts/bio-server-package.ts', 'scripts/bio-electron-build.ts']);
run(['scripts/bio-launch.mjs', 'build', 'run', 'scripts/bio-renderer-build.ts', 'web']);
run(['scripts/bio-launch.mjs', 'build', 'run', 'scripts/bio-electron-build.ts']);
run(['scripts/bio-launch.mjs', 'build', 'run', 'scripts/bio-renderer-build.ts', 'desktop']);
run(['scripts/bio-launch.mjs', 'test', 'run', 'packages/server/src/bio-resources.ts']);
console.log('BioEvidence validation completed.');
