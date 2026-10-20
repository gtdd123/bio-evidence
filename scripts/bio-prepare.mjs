import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PINNED_BUN_VERSION } from './bio-launch.mjs';

const root = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--bun') throw Error('Use --bun with the absolute path to an already acquired Bun 1.3.10 executable');
  const source = realpathSync.native(resolve(args[1]));
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const version = spawnSync(source, ['--version'], { cwd: dirname(root), env, encoding: 'utf8', windowsHide: true });
  if (version.status !== 0 || version.stdout.trim() !== PINNED_BUN_VERSION) throw Error('Expected existing Bun 1.3.10; nothing was prepared');
  let directory = root;
  for (const component of ['.tools', 'bun', PINNED_BUN_VERSION]) {
    directory = join(directory, component);
    if (existsSync(directory)) { if (lstatSync(directory).isSymbolicLink()) throw Error('Runtime preparation cannot follow a symlink'); }
    else mkdirSync(directory);
  }
  const name = process.platform === 'win32' ? 'bun.exe' : 'bun', target = join(directory, name);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw Error('Runtime executable cannot be a symlink');
  if (source !== target) copyFileSync(source, target);
  const executable = `.tools/bun/${PINNED_BUN_VERSION}/${name}`;
  const manifest = join(root, '.tools/bun-manifest.json');
  if (existsSync(manifest) && lstatSync(manifest).isSymbolicLink()) throw Error('Runtime manifest cannot be a symlink');
  writeFileSync(manifest, JSON.stringify({ version: PINNED_BUN_VERSION, executable, executableSha256: createHash('sha256').update(readFileSync(target)).digest('hex') }, null, 2) + '\n');
  console.log('Prepared project-local Bun 1.3.10. No dependencies were installed.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Runtime preparation failed'); process.exitCode = 1; }
