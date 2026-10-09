// Dependency-free namespace contract shared by preload, SDKs and the external
// Node launcher. Validation performs no filesystem access and no HOME lookup
// in BioEvidence mode, including the missing-configuration failure path.
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const RESTRICTED_HOOK_KEYS = new Set(['NODE_OPTIONS', 'BUN_OPTIONS', 'CLAUDE_CODE_DEBUG', 'DEBUG']);

/** @param {NodeJS.ProcessEnv} [env] */
export function isBioEvidenceMode(env = process.env) {
  return env.BIOEVIDENCE_MODE === '1';
}

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveConfigDir(env = process.env) {
  if (!isBioEvidenceMode(env)) return env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent');
  const root = env.BIOEVIDENCE_CONFIG_DIR;
  if (!root || !root.trim() || root.includes('\0') || !isAbsolute(root)) {
    throw new Error('BioEvidence namespace requires an absolute BIOEVIDENCE_CONFIG_DIR');
  }
  const canonical = resolve(root);
  if (canonical.split(/[\\/]/).some(part => /^\.craft-agent(?:-\d+)?$/i.test(part))) {
    throw new Error('BioEvidence namespace cannot use a legacy Craft directory');
  }
  if (env.CRAFT_CONFIG_DIR !== undefined && (!isAbsolute(env.CRAFT_CONFIG_DIR) || resolve(env.CRAFT_CONFIG_DIR) !== canonical)) {
    throw new Error('BioEvidence namespace aliases must identify the same absolute directory');
  }
  return canonical;
}

/** @param {string} directory @param {NodeJS.ProcessEnv} [env] */
export function validateNamespacePath(directory, env = process.env) {
  if (!isBioEvidenceMode(env)) return directory;
  const root = resolveConfigDir(env);
  const offset = relative(root, resolve(directory));
  if (!isAbsolute(directory) || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error('BioEvidence state path must remain within its namespace');
  }
  return resolve(directory);
}

/** @param {NodeJS.ProcessEnv} [env] */
export function getSdkPaths(env = process.env) {
  const root = resolveConfigDir(env);
  return { home: join(root, 'sdk', 'home'), claude: join(root, 'sdk', 'claude'), pi: join(root, 'sdk', 'pi'), xdg: join(root, 'sdk', 'xdg') };
}

/** @param {NodeJS.ProcessEnv} [env] */
export function getSdkHomeDir(env = process.env) {
  return isBioEvidenceMode(env) ? getSdkPaths(env).home : homedir();
}

/** @param {NodeJS.ProcessEnv} [env] */
export function getGlobalSkillsDir(env = process.env) {
  return isBioEvidenceMode(env) ? join(resolveConfigDir(env), 'sdk', 'agents', 'skills') : join(homedir(), '.agents', 'skills');
}

/** Force namespace aliases and SDK roots after validated per-session overrides.
 * @param {NodeJS.ProcessEnv} [base] @param {NodeJS.ProcessEnv} [overrides]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildNamespaceEnv(base = process.env, overrides = {}) {
  const env = { ...base, ...overrides };
  if (!isBioEvidenceMode(base)) return env;
  const root = resolveConfigDir(base);
  if (overrides.BIOEVIDENCE_MODE !== undefined && overrides.BIOEVIDENCE_MODE !== '1') throw new Error('BioEvidence mode cannot be overridden');
  env.BIOEVIDENCE_MODE = '1';
  if (resolveConfigDir(env) !== root) throw new Error('BioEvidence subprocess namespace cannot be overridden');
  const sdk = getSdkPaths(base);
  Object.assign(env, {
    BIOEVIDENCE_CONFIG_DIR: root, CRAFT_CONFIG_DIR: root,
    HOME: sdk.home, USERPROFILE: sdk.home, APPDATA: join(sdk.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(sdk.home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: sdk.claude, PI_CODING_AGENT_DIR: sdk.pi,
    XDG_CONFIG_HOME: join(sdk.xdg, 'config'), XDG_DATA_HOME: join(sdk.xdg, 'data'), XDG_CACHE_HOME: join(sdk.xdg, 'cache'), XDG_STATE_HOME: join(sdk.xdg, 'state'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    CRAFT_DEBUG: '0', CRAFT_DEBUG_SSE_RAW: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  // Windows resolves environment names without case sensitivity. Remove every
  // spelling from the child copy, including per-session mixed-case overrides.
  for (const key of Object.keys(env)) {
    if (RESTRICTED_HOOK_KEYS.has(key.toUpperCase())) delete env[key];
  }
  if (env.CRAFT_SESSION_DIR) env.CRAFT_SESSION_DIR = validateNamespacePath(env.CRAFT_SESSION_DIR, env);
  return env;
}

/** Guard product entry points before importing any application/SDK modules. */
export function assertBioEvidenceRuntime() {
  if (!isBioEvidenceMode()) throw new Error('BioEvidence must start through the isolated launcher');
  return resolveConfigDir();
}
