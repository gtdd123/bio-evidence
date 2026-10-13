import { test, expect, afterEach } from 'bun:test'
import { writeFileSync, rmSync, symlinkSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
import { loadMaterialGrants } from './material-grants-config'
const files: string[] = []
const directories: string[] = []
const owned = (name: string) => { const path = join(resolveConfigDir(), `t08-${crypto.randomUUID()}-${name}`); files.push(path); return path }
afterEach(() => { for (const path of files.splice(0)) rmSync(path, { force: true }); for (const path of directories.splice(0).reverse()) rmdirSync(path) })
test('deployment grants are strict operator configuration confined to the service namespace', () => {
  expect(loadMaterialGrants('nonexistent-t08-grants.json')).toEqual([])
  const path = owned('grants.json'), grant = { id: 'grant-a', scope: { kind: 'personal' as const, ownerId: 'alice' }, label: 'Synthetic', rootPath: 'D:/synthetic-lab-data' }
  writeFileSync(path, JSON.stringify([grant])); expect(loadMaterialGrants(path)).toEqual([grant])
  expect(() => loadMaterialGrants('../outside.json')).toThrow()
  writeFileSync(path, JSON.stringify([{ ...grant, actor: 'forged' }])); expect(() => loadMaterialGrants(path)).toThrow('Invalid research input.')
  writeFileSync(path, ' '.repeat(1048577)); expect(() => loadMaterialGrants(path)).toThrow('Invalid research input.')
})
test('an alias within the namespace cannot redirect the deployment manifest', () => {
  const sourceDir = join(resolveConfigDir(), `t08-source-${crypto.randomUUID()}`), aliasDir = join(resolveConfigDir(), `t08-alias-${crypto.randomUUID()}`)
  mkdirSync(sourceDir); directories.push(sourceDir)
  const source = join(sourceDir, 'grants.json'); files.push(source); writeFileSync(source, '[]')
  symlinkSync(sourceDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir'); directories.push(aliasDir)
  expect(() => loadMaterialGrants(join(aliasDir, 'grants.json'))).toThrow('Research access denied.')
})
