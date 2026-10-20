import './bio-runtime-guard.mjs'
import { build } from 'esbuild'
import { isBuiltin } from 'node:module'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { assertInside, readPinnedRuntime } from './bio-launch.mjs'
import { createDeliveryDirectory } from './bio-package-paths.mjs'

const root = realpathSync.native(resolve(import.meta.dirname, '..'))
const out = createDeliveryDirectory(root, 'service'), dependencies = new Set<string>(), copied = new Set<string>()
function copyFile(source: string, target: string) { assertInside(out, target, 'Delivery file'); mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target) }
function copyTree(source: string, target: string) {
  for (const item of readdirSync(source, { withFileTypes: true })) {
    if (item.name === 'node_modules') continue
    if (item.isSymbolicLink()) throw Error('Dependency contains an undeclared symbolic link')
    if (item.isDirectory()) copyTree(join(source, item.name), join(target, item.name))
    else if (item.isFile()) copyFile(join(source, item.name), join(target, item.name))
  }
}
function packageAt(start: string, expected?: string): string {
  let directory = start
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && (!expected || JSON.parse(readFileSync(manifest, 'utf8')).name === expected)) return realpathSync.native(directory)
    const parent = dirname(directory); if (parent === directory) throw Error('Dependency manifest not found'); directory = parent
  }
}
function dependencyFolder(name: string, from: string): string | undefined {
  for (let search = from;; search = dirname(search)) {
    const folder = join(search, 'node_modules', name)
    if (existsSync(join(folder, 'package.json'))) return realpathSync.native(folder)
    if (dirname(search) === search) return
  }
}
function copyDependency(folder: string) {
  assertInside(root, folder, 'Installed dependency')
  const parts = relative(root, folder).split(sep), index = parts.indexOf('node_modules')
  if (index !== 0 && !(index === 2 && ['packages', 'apps'].includes(parts[0]!))) throw Error('Dependency is outside declared installed package roots')
  if (copied.has(folder)) return
  copied.add(folder)
  const target = join(out, relative(root, folder))
  copyTree(folder, target)
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  dependencies.add(`${manifest.name}@${manifest.version}`)
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    const child = dependencyFolder(name, folder)
    if (!child) { if (manifest.optionalDependencies?.[name]) continue; throw Error(`Required installed dependency missing: ${name}@${version}`) }
    copyDependency(child)
  }
}
const serverOut = join(out, 'packages/server/src')
const entries = ['bio-index.ts', 'bio-account.ts', 'bio-resources.ts', 'document-worker.ts', 'pdf-extractor.ts', 'jats-extractor.ts', 'image-preview-worker.ts', 'public-pi-worker.ts']
for (const entry of entries) {
  console.log(JSON.stringify({ phase: 'bundle', entry }))
  const source = ['bio-index.ts', 'bio-account.ts', 'bio-resources.ts'].includes(entry) ? join(root, 'packages/server/src', entry) : join(root, 'packages/server-core/src/research', entry)
  const destination = join(serverOut, entry)
  await build({ entryPoints: [source], outfile: destination, bundle: true, platform: 'node', format: 'esm', target: 'es2022', sourcemap: false, logLevel: 'warning',
    plugins: [{ name: 'exact-installed-dependencies', setup(builder) {
      builder.onResolve({ filter: /^[^./\\]|^@/ }, async args => {
        if (args.pluginData?.skipBioResolver) return
        if (isAbsolute(args.path) || args.path.startsWith('file:')) return
        if (isBuiltin(args.path) || args.path.startsWith('bun:')) return { path: args.path, external: true }
        const resolution = await builder.resolve(args.path, { resolveDir: args.resolveDir || root, kind: args.kind, pluginData: { skipBioResolver: true } })
        if (resolution.errors.length) return { errors: resolution.errors }
        const resolved = realpathSync.native(resolution.path)
        if (/^@(?:craft-agent|bio-evidence)\//.test(args.path)) return { path: resolved }
        const name = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0]!
        const installed = packageAt(dirname(resolved), name); copyDependency(installed)
        const target = join(out, relative(root, resolved))
        return { path: './' + relative(dirname(destination), target).split(sep).join('/'), external: true }
      })
    } }],
  })
}
for (const path of ['scripts/bio-launch.mjs', 'scripts/bio-start.mjs', 'scripts/bio-runtime-guard.mjs', 'scripts/bunfig.bio-bootstrap.toml', 'packages/shared/src/config/namespace.mjs', 'LICENSE', 'NOTICE']) copyFile(join(root, path), join(out, path))
copyFile(join(root, 'docs/bioevidence/SERVICE_RUNTIME.md'), join(out, 'README.md'))
const pinned = JSON.parse(readFileSync(join(root, '.tools/bun-manifest.json'), 'utf8'))
copyFile(readPinnedRuntime(root), join(out, pinned.executable)); copyFile(join(root, '.tools/bun-manifest.json'), join(out, '.tools/bun-manifest.json'))
copyTree(join(root, 'apps/webui/dist'), join(out, 'apps/webui/dist'))
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'bio-evidence-service', version: '0.1.0', private: true, type: 'module', license: 'Apache-2.0' }, null, 2))
const files: { path: string; bytes: number; sha256?: string }[] = []
function inventory(directory: string) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name)
    if (item.isSymbolicLink() || lstatSync(file).isSymbolicLink()) throw Error('Output symlinks are not distributable')
    if (item.isDirectory()) inventory(file)
    else {
      const path = relative(out, file).split(sep).join('/')
      files.push({ path, bytes: statSync(file).size, ...(!path.includes('node_modules/') ? { sha256: createHash('sha256').update(readFileSync(file)).digest('hex') } : {}) })
    }
  }
}
console.log(JSON.stringify({ phase: 'inventory', dependencies: dependencies.size }))
inventory(out)
writeFileSync(join(out, 'bio-delivery.json'), JSON.stringify({ product: 'BioEvidence', version: '0.1.0', kind: 'service-runtime-directory', platform: process.platform, arch: process.arch, runtime: 'Bun 1.3.10', dependencies: [...dependencies].sort(), files }, null, 2))
console.log(JSON.stringify({ product: 'BioEvidence', directory: out, dependencies: dependencies.size, files: files.length }))
