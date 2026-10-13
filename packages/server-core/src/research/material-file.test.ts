import { test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { resolve, join, relative, sep, isAbsolute } from 'node:path'
import { SqliteResearchRepository } from './sqlite-repository'
import { MaterialsService } from './materials-service'
const actor = { userId: 'alice', authSessionId: 'synthetic-auth', active: true, administrator: true }
let root: string, repo: SqliteResearchRepository, materials: MaterialsService
beforeEach(() => {
  mkdirSync(resolve('.fixtures'), { recursive: true }); root = mkdtempSync(resolve('.fixtures/t09-files-'))
  repo = new SqliteResearchRepository(); repo.seedUser({ id: actor.userId, username: 'alice', passwordHash: 'synthetic', active: true, administrator: true, revision: 1 })
  materials = new MaterialsService(repo, [{ id: 'grant-a', scope: { kind: 'personal', ownerId: actor.userId }, label: 'Synthetic', rootPath: root }])
})
afterEach(() => {
  repo.close(); const offset = relative(realpathSync.native(resolve('.fixtures')), realpathSync.native(root))
  if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned stream cleanup boundary')
  rmSync(root, { recursive: true, force: true })
})
test('controlled files stream selected originals in chunks with repeated current authority and no writes', async () => {
  const bytes = Buffer.alloc(180000, 72); writeFileSync(join(root, 'large.bin'), bytes)
  const material = materials.registerRoot(actor, 'grant-a', ''); await materials.indexDirectory(actor, material.id)
  const page = materials.list(actor, material.id), file = await materials.openFile(actor, material.id, '', page.generation, page.items[0]!.id)
  const received: Uint8Array[] = []
  try {
    for await (const chunk of file.chunks()) { expect(chunk.length).toBeLessThanOrEqual(65536); received.push(chunk) }
    expect(Buffer.concat(received)).toEqual(bytes); expect('path' in file).toBe(false)
  } finally { await file.close() }
  expect(file.closed).toBe(true)
})
test('current account loss between stream chunks stops delivery and closes the descriptor', async () => {
  writeFileSync(join(root, 'large.bin'), Buffer.alloc(180000, 72))
  const material = materials.registerRoot(actor, 'grant-a', ''); await materials.indexDirectory(actor, material.id)
  const page = materials.list(actor, material.id), file = await materials.openFile(actor, material.id, '', page.generation, page.items[0]!.id)
  const iterator = file.chunks()
  expect((await iterator.next()).value?.length).toBe(65536)
  repo.seedUser({ id: 'admin', username: 'admin', passwordHash: 'synthetic', active: true, administrator: true, revision: 1 })
  repo.setAccountActive({ userId: 'admin', authSessionId: 'synthetic-admin-auth', active: true, administrator: true }, actor.userId, false, 1)
  await expect(iterator.next()).rejects.toThrow('Research access denied.')
  expect(file.closed).toBe(true)
})
