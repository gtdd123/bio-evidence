import { isAbsolute, join, dirname, resolve } from 'node:path';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { buildNamespaceEnv, getSdkPaths, resolveConfigDir } from '../../../../packages/shared/src/config/namespace.mjs';

/** Package bootstrap only: no server credentials or legacy product profile. */
export function createBioDesktopEnv(base, { packaged, appData }) {
  let root;
  if (base.BIOEVIDENCE_MODE === '1') {
    root = resolveConfigDir(base);
    const sdk = getSdkPaths(base);
    if (base.HOME !== sdk.home || base.USERPROFILE !== sdk.home || base.CLAUDE_CONFIG_DIR !== sdk.claude || base.PI_CODING_AGENT_DIR !== sdk.pi) throw Error('Desktop requires isolated SDK roots');
  } else {
    if (!packaged || !isAbsolute(appData)) throw Error('Source desktop must use the BioEvidence launcher');
    root = join(appData, 'BioEvidence');
  }
  const allowed = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'WINDIR', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (typeof base[key] === 'string') allowed[key] = base[key];
  return buildNamespaceEnv({ ...allowed, BIOEVIDENCE_MODE: '1', BIOEVIDENCE_CONFIG_DIR: root, CRAFT_CONFIG_DIR: root, CRAFT_APP_NAME: 'BioEvidence', CRAFT_DEEPLINK_SCHEME: 'bioevidence', NODE_ENV: 'production' });
}

/** Verify every existing ancestor of all targets before the first write. */
export function prepareBioDesktopDirectories(root) {
  if (!isAbsolute(root)) throw Error('Desktop namespace must be absolute');
  const profiles = { userData: join(root, 'electron'), sessionData: join(root, 'electron-session'), logs: join(root, 'logs') };
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (const target of [root, ...Object.values(profiles)]) {
    let existing = resolve(target);
    while (!existsSync(existing)) { const parent = dirname(existing); if (parent === existing) throw Error('Desktop namespace has no existing ancestor'); existing = parent; }
    for (;;) {
      if (lstatSync(existing).isSymbolicLink() || !same(realpathSync.native(existing), resolve(existing))) throw Error('Desktop namespace cannot redirect through a symlink');
      const parent = dirname(existing); if (parent === existing) break; existing = parent;
    }
  }
  for (const directory of [root, ...Object.values(profiles)]) {
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink() || !same(realpathSync.native(directory), resolve(directory))) throw Error('Desktop namespace changed during initialization');
  }
  return profiles;
}
