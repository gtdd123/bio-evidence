import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function createDeliveryDirectory(projectRoot, kind) {
  if (!['service', 'desktop'].includes(kind)) throw Error('Unknown delivery kind');
  let parent = realpathSync.native(projectRoot);
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (const component of ['.runtime', 'build', 'deliveries']) {
    parent = join(parent, component);
    if (existsSync(parent)) {
      if (lstatSync(parent).isSymbolicLink() || !same(realpathSync.native(parent), resolve(parent))) throw Error('Delivery output cannot redirect through a symlink');
    } else mkdirSync(parent);
  }
  return mkdtempSync(join(parent, `${kind}-`));
}
