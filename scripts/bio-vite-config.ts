import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve, join, dirname } from 'node:path'
import { readdirSync, readFileSync, writeFileSync, existsSync, realpathSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '..')
function manifest(out: string): Plugin {
  return { name: 'bio-evidence-asset-manifest', apply: 'build', closeBundle() {
    const files: Array<{ path: string; sha256: string }> = []
    const include = (path: string) => files.push({ path, sha256: createHash('sha256').update(readFileSync(join(out, path))).digest('hex') })
    const visit = (directory: string) => { for (const item of readdirSync(join(out, directory), { withFileTypes: true })) {
      const path = directory + '/' + item.name
      if (item.isSymbolicLink()) throw Error('UI assets cannot be symlinks')
      if (item.isDirectory()) visit(path)
      else if (/\.(?:js|css|woff2?|svg|png|ico)$/.test(path)) include(path)
    } }
    include('index.html'); visit('assets')
    writeFileSync(join(out, 'bio-ui.json'), JSON.stringify({ product: 'BioEvidence', version: 1, files: files.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2))
  } }
}
export function bioRendererConfig(web: boolean) {
  const demo = web && process.env.VITE_DEMO_MODE === 'true'
  const output = web ? demo ? 'apps/webui/dist-demo' : 'apps/webui/dist' : 'apps/electron/dist/renderer'
  const source = resolve(root, web ? 'apps/webui/src' : 'apps/electron/src/renderer'), out = resolve(root, output)
  // Vite may recursively empty only these exact, owned output folders.
  const canonicalRoot = realpathSync.native(root), expected = resolve(canonicalRoot, output)
  const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!samePath(realpathSync.native(dirname(out)), dirname(expected)) || existsSync(out) && (lstatSync(out).isSymbolicLink() || !samePath(realpathSync.native(out), expected))) throw Error('Invalid Bio renderer output boundary')
  return defineConfig({ envDir: false, envPrefix: [], root: source, base: './',
    plugins: [react(), tailwindcss(), ...(web ? [manifest(out)] : [])],
    build: { outDir: out, emptyOutDir: true, sourcemap: false, rollupOptions: { input: resolve(source, web ? 'index.html' : 'bio.html') } },
    resolve: { dedupe: ['react', 'react-dom'], alias: {
      '@': resolve(root, 'apps/electron/src/renderer'), '@config': resolve(root, 'packages/shared/src/config'),
      react: resolve(root, 'node_modules/react'), 'react-dom': resolve(root, 'node_modules/react-dom'),
      ws: resolve(root, 'apps/webui/src/shims/ws.ts'),
      'fs/promises': resolve(root, 'apps/webui/src/shims/fs-promises.ts'), 'node:fs/promises': resolve(root, 'apps/webui/src/shims/fs-promises.ts'),
      ...Object.fromEntries(['fs', 'node:fs', 'path', 'node:path', 'child_process', 'node:child_process', 'os', 'node:os', 'node:crypto', 'node:util', 'node:process', 'node:buffer',
        'node:https', 'node:http', 'node:net', 'node:url', 'node:events', 'crypto', 'https', 'http', 'net', 'events', 'util', 'buffer', 'stream', 'node:stream', 'tls', 'node:tls', 'url', 'zlib', 'node:zlib', 'string_decoder', 'node:string_decoder', 'assert', 'node:assert']
        .map(name => [name, resolve(root, 'apps/webui/src/shims/node-builtins.ts')])),
    } },
    define: { 'import.meta.env.IS_WEBUI': String(web), 'import.meta.env.VITE_DEMO_MODE': String(demo) }, server: { host: '127.0.0.1', open: false, strictPort: true },
  })
}
