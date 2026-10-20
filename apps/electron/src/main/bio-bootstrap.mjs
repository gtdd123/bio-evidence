// Evaluate before Electron modules can use cookies, caches or log profiles.
import { app } from 'electron';
import { createBioDesktopEnv, prepareBioDesktopDirectories } from './bio-desktop-env.mjs';
import { resolveConfigDir } from '../../../../packages/shared/src/config/namespace.mjs';

const isolated = createBioDesktopEnv(process.env, { packaged: app.isPackaged, appData: app.isPackaged && process.env.BIOEVIDENCE_MODE !== '1' ? app.getPath('appData') : '' });
for (const key of Object.keys(process.env)) if (!Object.hasOwn(isolated, key)) delete process.env[key];
Object.assign(process.env, isolated);
const root = resolveConfigDir();
const profiles = prepareBioDesktopDirectories(root);
app.setName('BioEvidence');
for (const [name, directory] of Object.entries(profiles)) app.setPath(name, directory);
