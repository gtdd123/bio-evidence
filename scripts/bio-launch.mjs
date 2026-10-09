import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_BUN_VERSION = '1.3.10';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PURPOSES = new Set(['bootstrap', 'install', 'test', 'build', 'runtime']);
const COMMANDS = new Set(['run', 'test', 'install', 'build', '--version', '--help']);
const OS_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
];
const RESERVED_ARGS = /^(?:--(?:config|cwd|preload|require|import|env-file|define)(?:=|$)|-(?:c|r|d))/;

export function assertInside(root, target, label) {
  const offset = relative(resolve(root), resolve(target));
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error(`${label} must stay within the project`);
  }
}

export function readPinnedRuntime(projectRoot) {
  const manifest = JSON.parse(readFileSync(join(projectRoot, '.tools', 'bun-manifest.json'), 'utf8'));
  if (manifest.version !== PINNED_BUN_VERSION || typeof manifest.executable !== 'string') {
    throw new Error('Expected project-local Bun 1.3.10 manifest');
  }
  const executable = resolve(projectRoot, manifest.executable);
  assertInside(join(projectRoot, '.tools'), executable, 'Bun executable');
  if (!existsSync(executable)) throw new Error('Pinned Bun executable is not prepared');
  assertInside(realpathSync(join(projectRoot, '.tools')), realpathSync(executable), 'Bun executable');
  return executable;
}

export function rejectAutoEnvFiles(projectRoot) {
  // Bun 1.3.10 predates --no-env-file. Never rely on a filtered inherited
  // environment while leaving auto-loaded .env files in a command workspace.
  const directories = [projectRoot];
  for (const folder of ['apps', 'packages']) {
    const parent = join(projectRoot, folder);
    if (!existsSync(parent)) continue;
    for (const item of readdirSync(parent, { withFileTypes: true })) {
      if (item.isDirectory()) directories.push(join(parent, item.name));
    }
  }
  for (const directory of directories) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (!/^\.env(?:\.|$)/i.test(item.name)) continue;
      if (/^\.env\.(?:example|sample|template)$/i.test(item.name)) continue;
      throw new Error('Automatic .env loading is not permitted; use explicit backend configuration');
    }
  }
}

export function createLaunchSpec({ projectRoot, executable, purpose, args, baseEnv = process.env }) {
  const root = resolve(projectRoot);
  if (!PURPOSES.has(purpose)) throw new Error('Unknown launch purpose');
  if (!Array.isArray(args) || !COMMANDS.has(args[0])) throw new Error('Unsupported Bun command');
  if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || RESERVED_ARGS.test(arg))) {
    throw new Error('Command may not override the isolated configuration');
  }
  if (!isAbsolute(executable)) throw new Error('Pinned executable must be absolute');
  assertInside(join(root, '.tools'), executable, 'Bun executable');
  const stateRoot = join(root, '.runtime', purpose);
  const env = {};
  for (const key of OS_ENV_KEYS) {
    if (typeof baseEnv[key] === 'string') env[key] = baseEnv[key];
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = `${dirname(executable)}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] || ''}`;
  env.BIOEVIDENCE_MODE = '1';
  env.BIOEVIDENCE_CONFIG_DIR = stateRoot;
  env.CRAFT_CONFIG_DIR = stateRoot;
  env.CRAFT_APP_NAME = 'BioEvidence';
  env.CRAFT_DEEPLINK_SCHEME = 'bioevidence';
  env.CRAFT_DEBUG = '0';
  env.NODE_ENV = purpose === 'build' ? 'production' : purpose === 'test' ? 'test' : 'development';
  env.BUN_INSTALL_CACHE_DIR = join(root, '.runtime', 'cache', 'bun-install');
  env.BUN_TMPDIR = join(root, '.runtime', 'tmp');
  const config = join(root, 'scripts', 'bunfig.bio-bootstrap.toml');
  // Bun 1.3.10 requires the inline form; a separate value can leave the
  // default preload active. Keep the subcommand first for its own parser.
  const isolatedArgs = args[0].startsWith('--')
    ? [`--config=${config}`, ...args]
    : [args[0], `--config=${config}`, ...args.slice(1)];
  return { executable, args: isolatedArgs, cwd: root, env, stateRoot };
}

export function launch({ purpose, args, projectRoot = PROJECT_ROOT }) {
  rejectAutoEnvFiles(projectRoot);
  const executable = readPinnedRuntime(projectRoot);
  const spec = createLaunchSpec({ projectRoot, executable, purpose, args });
  // Version-only probe runs outside the repository and does not execute an
  // application, package lifecycle, or SDK.
  const version = spawnSync(executable, ['--version'], {
    cwd: dirname(projectRoot), env: spec.env, encoding: 'utf8', windowsHide: true,
  });
  if (version.status !== 0 || version.stdout.trim() !== PINNED_BUN_VERSION) {
    throw new Error('Pinned Bun version check failed');
  }
  for (const directory of [spec.stateRoot, spec.env.BUN_INSTALL_CACHE_DIR, spec.env.BUN_TMPDIR]) {
    mkdirSync(directory, { recursive: true });
  }
  const child = spawnSync(spec.executable, spec.args, {
    cwd: spec.cwd, env: spec.env, stdio: 'inherit', windowsHide: true,
  });
  if (child.error) throw new Error('Isolated Bun process could not start');
  return child.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [purpose, ...args] = process.argv.slice(2);
    process.exitCode = launch({ purpose, args });
  } catch (error) {
    console.error(`[BioEvidence launcher] ${error instanceof Error ? error.message : 'Launch rejected'}`);
    process.exitCode = 1;
  }
}
