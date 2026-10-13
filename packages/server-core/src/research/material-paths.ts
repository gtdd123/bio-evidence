import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ResearchError } from '@bio-evidence/research-core'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
const forbidden = /^(?:\.git|\.ssh|\.aws|\.codex|\.claude|\.pi|\.kube|\.gnupg|\.config|AppData|\.craft-agent(?:-\d+)?|\.bio-evidence|\.runtime|\.tools|node_modules|\.env(?:\..*)?)$/i
export function materialRelativePath(input: string): string {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f\x7f:]/.test(input) || /^[\\/]/.test(input)) throw new ResearchError('BIO_ACCESS_DENIED')
  const segments = input.replaceAll('\\', '/').split('/')
  if (segments.some(part => part === '..' || part === '.' || /[. ]$/.test(part) || forbidden.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part))) throw new ResearchError('BIO_ACCESS_DENIED')
  return segments.filter(Boolean).join('/')
}
export function inside(root: string, target: string): boolean {
  const offset = relative(root, target)
  return offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
}
export function checkedGrantRoot(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new ResearchError('BIO_ACCESS_DENIED')
  const root = resolve(path), config = resolveConfigDir()
  if (inside(root, config) || inside(config, root) || root.split(/[\\/]/).some(part => forbidden.test(part))) throw new ResearchError('BIO_ACCESS_DENIED')
  return root
}
export function checkedMaterialPath(root: string, relativePath: string): string {
  root = checkedGrantRoot(root)
  const suffix = materialRelativePath(relativePath)
  try {
    if (!statSync(root).isDirectory() || relative(root, realpathSync.native(root)) !== '') throw new ResearchError('BIO_ACCESS_DENIED')
    let current = root
    if (lstatSync(root).isSymbolicLink()) throw new ResearchError('BIO_ACCESS_DENIED')
    for (const segment of suffix.split('/').filter(Boolean)) {
      current = resolve(current, segment)
      if (!inside(root, current) || lstatSync(current).isSymbolicLink() || !inside(root, realpathSync.native(current))) throw new ResearchError('BIO_ACCESS_DENIED')
    }
    return current
  } catch (error) {
    if (error instanceof ResearchError) throw error
    throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
  }
}
export function fileSignature(path: string): string {
  const info = lstatSync(path, { bigint: true })
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}
export function naturalMaterialKey(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/\d+/g, digits => {
    const value = digits.replace(/^0+(?=\d)/, '')
    return `\u0001${String(value.length).padStart(6, '0')}:${value}:${String(digits.length).padStart(6, '0')}\u0002`
  })
}
