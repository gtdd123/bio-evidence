import './bio-runtime-guard.mjs'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createPackage, extractFile } from '@electron/asar'
import { flipFuses, FuseVersion, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import sharp from 'sharp'
import { createDeliveryDirectory } from './bio-package-paths.mjs'
import { assertInside } from './bio-launch.mjs'

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('This delivery target requires Windows x64')
const root = resolve(import.meta.dirname, '..'), out = createDeliveryDirectory(root, 'desktop')
const runtime = join(root, 'node_modules/electron/dist'), appSource = join(out, 'app-source'), portable = join(out, 'BioEvidence-win32-x64')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (readFileSync(join(runtime, 'version'), 'utf8').trim() !== '39.2.7') throw Error('Expected existing Electron 39.2.7')
function copy(source: string, target: string) { assertInside(out, target, 'Desktop output'); mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target) }
function tree(source: string, target: string, electronRuntime = false) {
  for (const item of readdirSync(source, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw Error('Desktop resources cannot contain symlinks')
    if (electronRuntime && item.name === 'default_app.asar') continue
    const destination = join(target, electronRuntime && item.name === 'electron.exe' ? 'BioEvidence.exe' : item.name)
    if (item.isDirectory()) tree(join(source, item.name), destination, electronRuntime)
    else copy(join(source, item.name), destination)
  }
}
tree(runtime, portable, true)
for (const name of ['bio-main.cjs', 'bio-preload.cjs']) copy(join(root, 'apps/electron/dist', name), join(appSource, 'dist', name))
tree(join(root, 'apps/electron/dist/renderer'), join(appSource, 'dist/renderer'))
for (const name of ['LICENSE', 'NOTICE']) copy(join(root, name), join(appSource, name))
const png = await sharp(join(root, 'apps/electron/branding/bio.svg')).resize(256, 256).png().toBuffer()
mkdirSync(join(appSource, 'dist'), { recursive: true }); writeFileSync(join(appSource, 'dist/bio.png'), png)
const icon = Buffer.alloc(22); icon.writeUInt16LE(1, 2); icon.writeUInt16LE(1, 4); icon.writeUInt16LE(1, 10); icon.writeUInt16LE(32, 12); icon.writeUInt32LE(png.length, 14); icon.writeUInt32LE(22, 18)
const iconFile = join(out, 'bio.ico'); writeFileSync(iconFile, Buffer.concat([icon, png]))
writeFileSync(join(appSource, 'package.json'), JSON.stringify({ name: 'bio-evidence-desktop', productName: 'BioEvidence', version, main: 'dist/bio-main.cjs', appId: 'com.gtdd123.bioevidence', private: true, description: 'BioEvidence research desktop client', license: 'Apache-2.0' }, null, 2))
await createPackage(appSource, join(portable, 'resources/app.asar'))
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
for (const path of [join('dist', 'bio-main.cjs'), join('dist', 'bio-preload.cjs'), join('dist', 'renderer', 'bio.html')]) {
  if (sha256(readFileSync(join(appSource, path))) !== sha256(extractFile(join(portable, 'resources/app.asar'), path))) throw Error('Packaged desktop module differs from its build')
}
const executable = join(portable, 'BioEvidence.exe')
// Use the already locked builder resource library: old rcedit cannot open this
// workspace's Unicode path. No downloaded tool or global installation is used.
const builderRequire = createRequire(join(root, 'node_modules/app-builder-lib/package.json'))
const ResEdit = builderRequire('resedit'), peRequire = createRequire(builderRequire.resolve('resedit'))
const PE = peRequire('pe-library'), exe = PE.NtExecutable.from(readFileSync(executable), { ignoreCert: true }), resources = PE.NtExecutableResource.from(exe)
const parsedIcon = ResEdit.Data.IconFile.from(readFileSync(iconFile))
for (const group of ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, parsedIcon.icons.map((item: { data: unknown }) => item.data))
for (const info of ResEdit.Resource.VersionInfo.fromEntries(resources.entries)) {
  info.setFileVersion(version, 1033); info.setProductVersion(version, 1033)
  for (const language of info.getAllLanguagesForStringValues()) info.setStringValues(language, { ProductName: 'BioEvidence', FileDescription: 'BioEvidence research desktop client', CompanyName: 'BioEvidence contributors', OriginalFilename: 'BioEvidence.exe', InternalName: 'BioEvidence', LegalCopyright: 'BioEvidence contributors; see NOTICE for upstream attribution' })
  info.outputToResourceEntries(resources.entries)
}
resources.outputResource(exe); writeFileSync(executable, Buffer.from(exe.generate()))
await flipFuses(executable, { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: false, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, [FuseV1Options.EnableNodeCliInspectArguments]: false, [FuseV1Options.OnlyLoadAppFromAsar]: true })
const fuses = await getCurrentFuseWire(executable)
if ([FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseV1Options.EnableNodeCliInspectArguments].some(key => fuses[key] !== 48) || fuses[FuseV1Options.OnlyLoadAppFromAsar] !== 49) throw Error('Desktop runtime fuses differ from the requested settings')
writeFileSync(join(out, 'bio-desktop.json'), JSON.stringify({ product: 'BioEvidence', version, appId: 'com.gtdd123.bioevidence', platform: 'win32', arch: 'x64', kind: 'unsigned-portable-directory', electron: '39.2.7', fuses, exeSha256: sha256(readFileSync(executable)), asarSha256: sha256(readFileSync(join(portable, 'resources/app.asar'))) }, null, 2))
console.log(JSON.stringify({ product: 'BioEvidence', directory: portable, kind: 'unsigned-portable-directory', version }))
