import './bio-runtime-guard.mjs'
import { build } from 'esbuild'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import sharp from 'sharp'
import { createClientDefines } from './bio-build.mjs'
const root = join(import.meta.dir, '..'), out = join(root, 'apps/electron/dist')
mkdirSync(out, { recursive: true })
await sharp(join(root, 'apps/electron/branding/bio.svg')).resize(256, 256).png().toFile(join(out, 'bio.png'))
for (const [entry, name] of [['main/bio-main.ts', 'bio-main.cjs'], ['preload/bio-preload.ts', 'bio-preload.cjs']]) {
  await build({ entryPoints: [join(root, 'apps/electron/src', entry!)], outfile: join(out, name!), bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', external: ['electron'], define: createClientDefines(), sourcemap: false, logLevel: 'info' })
}
