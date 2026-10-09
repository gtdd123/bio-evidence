// Evaluate before Electron modules can use cookies, caches or log profiles.
import '../../../../scripts/bio-runtime-guard.mjs';
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfigDir } from '../../../../packages/shared/src/config/namespace.mjs';

const root = resolveConfigDir();
app.setName('BioEvidence');
for (const [name, folder] of Object.entries({ userData: 'electron', sessionData: 'electron-session', logs: 'logs' })) {
  const directory = join(root, folder);
  mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
