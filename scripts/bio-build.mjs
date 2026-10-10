import { join } from 'node:path';
import { buildNamespaceEnv, assertBioEvidenceRuntime } from '../packages/shared/src/config/namespace.mjs';
import { PINNED_BUN_VERSION } from './bio-launch.mjs';

const BUILD_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'BUN_INSTALL_CACHE_DIR', 'BUN_TMPDIR',
];

export function createBuildEnv(base = process.env) {
  const env = {};
  for (const key of BUILD_ENV_KEYS) if (typeof base[key] === 'string') env[key] = base[key];
  Object.assign(env, {
    BIOEVIDENCE_MODE: base.BIOEVIDENCE_MODE,
    BIOEVIDENCE_CONFIG_DIR: base.BIOEVIDENCE_CONFIG_DIR,
    CRAFT_CONFIG_DIR: base.CRAFT_CONFIG_DIR,
    NODE_ENV: 'production', HUSKY: '0', CRAFT_APP_NAME: 'BioEvidence',
    CRAFT_DEEPLINK_SCHEME: 'bioevidence',
  });
  if (env.BIOEVIDENCE_MODE !== '1') throw new Error('Build must run through the BioEvidence launcher');
  return buildNamespaceEnv(env);
}

export function buildBunCommand(args, root) {
  assertBioEvidenceRuntime();
  if (process.versions.bun !== PINNED_BUN_VERSION) throw new Error('Build requires pinned Bun');
  return [process.execPath, args[0], `--config=${join(root, 'scripts', 'bunfig.bio-bootstrap.toml')}`, ...args.slice(1)];
}

// Client bundles have no deployment credentials or telemetry endpoint. Model
// configuration remains server-side; no value is read from the build env.
export function createClientDefines() {
  return Object.fromEntries([
    'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
    'SLACK_OAUTH_CLIENT_ID', 'SLACK_OAUTH_CLIENT_SECRET',
    'MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET',
    'SENTRY_ELECTRON_INGEST_URL',
  ].map(key => [`process.env.${key}`, JSON.stringify('')]).concat([
    ['process.env.CRAFT_DEV_RUNTIME', JSON.stringify('0')],
  ]));
}
