import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { resolve, join, relative, isAbsolute, sep, basename } from 'node:path'
import { open } from 'node:fs/promises'
import sharp from 'sharp'
import { MaterialsService } from './materials-service'
import { SqliteResearchRepository } from './sqlite-repository'
import { MaterialPreviewService } from './material-preview'
import { ImageDecodeService, type ImageDecodeKind } from './image-decode'
const actor = { userId: 'alice', authSessionId: 'synthetic-auth', active: true, administrator: true }
let root: string, repo: SqliteResearchRepository, materials: MaterialsService, previews: MaterialPreviewService
let openedNames: string[]
beforeEach(() => {
  mkdirSync(resolve('.fixtures'), { recursive: true }); root = mkdtempSync(resolve('.fixtures/t09-preview-'))
  repo = new SqliteResearchRepository(); repo.seedUser({ id: actor.userId, username: 'alice', passwordHash: 'synthetic', active: true, administrator: true, revision: 1 })
  openedNames = []
  materials = new MaterialsService(repo, [{ id: 'grant-a', scope: { kind: 'personal', ownerId: actor.userId }, label: 'Synthetic', rootPath: root }], {
    openFile: async (path, flags) => { openedNames.push(basename(String(path))); return open(path, flags) },
  })
  previews = new MaterialPreviewService(materials)
})
afterEach(() => {
  repo.close(); const offset = relative(realpathSync.native(resolve('.fixtures')), realpathSync.native(root))
  if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned preview cleanup boundary')
  rmSync(root, { recursive: true, force: true })
})
test('resource-bound previews open only the selected image and preserve originals', async () => {
  const input = await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#56a1dc' } }).png().toBuffer()
  writeFileSync(join(root, 'frame1.png'), input); writeFileSync(join(root, 'frame2.png'), input)
  const material = materials.registerRoot(actor, 'grant-a', ''); await materials.indexDirectory(actor, material.id)
  const page = materials.list(actor, material.id), fileId = page.items[0]!.id
  const result = await previews.preview(actor, material.id, '', page.generation, fileId, 'thumbnail', 0)
  expect(result.status).toBe('ok'); expect(result.policy).toBe('restricted'); expect(result.fileId).toBe(fileId)
  if (result.status !== 'ok') throw Error('Expected controlled preview')
  expect(result.width).toBe(256); expect(result.height).toBe(205)
  expect((await sharp(result.bytes!).metadata()).format).toBe('png')
  expect(openedNames).toEqual(['frame1.png'])
  expect(readFileSync(join(root, 'frame1.png')).equals(input)).toBe(true)
  await expect(previews.preview(actor, material.id, '', page.generation, 'unknown', 'view', 0)).rejects.toThrow('Research access denied.')
})
test('a source changing during actual decoding cannot publish the completed preview', async () => {
  const path = join(root, 'frame1.png'), input = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#56a1dc' } }).png().toBuffer()
  writeFileSync(path, input)
  const material = materials.registerRoot(actor, 'grant-a', ''); await materials.indexDirectory(actor, material.id)
  const page = materials.list(actor, material.id)
  class ChangedSourceDecoder extends ImageDecodeService {
    override async decode(bytes: Uint8Array, kind: ImageDecodeKind, frameIndex = 0) {
      const result = await super.decode(bytes, kind, frameIndex)
      writeFileSync(path, Buffer.from('Synthetic replacement')); return result
    }
  }
  previews = new MaterialPreviewService(materials, {}, new ChangedSourceDecoder())
  await expect(previews.preview(actor, material.id, '', page.generation, page.items[0]!.id, 'view', 0)).rejects.toThrow('The revision has changed.')
})
test('an account disabled during actual decoding cannot receive the completed preview', async () => {
  writeFileSync(join(root, 'frame1.png'), await sharp({ create: { width: 80, height: 40, channels: 3, background: '#56a1dc' } }).png().toBuffer())
  const material = materials.registerRoot(actor, 'grant-a', ''); await materials.indexDirectory(actor, material.id)
  const page = materials.list(actor, material.id)
  repo.seedUser({ id: 'admin', username: 'admin', passwordHash: 'synthetic', active: true, administrator: true, revision: 1 })
  class RevokedDecoder extends ImageDecodeService {
    override async decode(bytes: Uint8Array, kind: ImageDecodeKind, frameIndex = 0) {
      const result = await super.decode(bytes, kind, frameIndex)
      repo.setAccountActive({ userId: 'admin', authSessionId: 'synthetic-admin-auth', active: true, administrator: true }, actor.userId, false, 1)
      return result
    }
  }
  previews = new MaterialPreviewService(materials, {}, new RevokedDecoder())
  await expect(previews.preview(actor, material.id, '', page.generation, page.items[0]!.id, 'view', 0)).rejects.toThrow('Research access denied.')
})
