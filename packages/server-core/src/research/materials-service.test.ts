import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync, symlinkSync, readFileSync, renameSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
import { resolve, join, relative, sep, isAbsolute } from 'node:path'
import { SqliteResearchRepository } from './sqlite-repository'
import { MaterialsService } from './materials-service'
const alice = { userId: 'alice', authSessionId: 'auth-a', active: true, administrator: true }
const bob = { userId: 'bob', authSessionId: 'auth-b', active: true, administrator: false }
const scope = { kind: 'personal', ownerId: 'alice' } as const
describe('pre-authorized local research materials', () => {
  let root: string, repo: SqliteResearchRepository, service: MaterialsService
  beforeEach(() => {
    const fixtures = resolve('.fixtures'); mkdirSync(fixtures, { recursive: true }); root = mkdtempSync(join(fixtures, 't08-materials-'))
    repo = new SqliteResearchRepository()
    for (const actor of [alice, bob]) repo.seedUser({ id: actor.userId, username: actor.userId, passwordHash: 'synthetic-hash', active: true, administrator: actor.administrator, revision: 1 })
    service = new MaterialsService(repo, [{ id: 'grant-a', scope, label: 'Synthetic experiment files', rootPath: root }])
  })
  afterEach(() => {
    repo.close()
    const offset = relative(realpathSync.native(resolve('.fixtures')), realpathSync.native(root))
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned material cleanup boundary')
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
  test('authorized root registration is restricted and does not grant other users disk access', () => {
    const material = service.registerRoot(alice, 'grant-a', '')
    expect(material.policy).toBe('restricted'); expect(material.scope).toEqual(scope)
    expect('rootPath' in material).toBe(false)
    expect(() => service.registerRoot(bob, 'grant-a', '')).toThrow('Research access denied.')
    expect(() => service.registerRoot(alice, 'unknown-grant', '')).toThrow('Research access denied.')
  })
  test('prefix traversal, credential folders and same-host junctions cannot become registered materials', () => {
    mkdirSync(join(root, 'safe')); mkdirSync(join(root, '.ssh')); writeFileSync(join(root, '.ssh', 'key'), 'synthetic forbidden')
    const sibling = join(root, 'outside'); mkdirSync(sibling)
    symlinkSync(sibling, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const path of ['../outside', '/absolute', 'C:\\absolute', '.ssh', 'alias', 'safe/../../outside', 'file:stream']) {
      expect(() => service.registerRoot(alice, 'grant-a', path)).toThrow()
    }
  })
  test('nested cross-scope root grants fail closed, while explicit equal-root grants remain separately authorized', () => {
    mkdirSync(join(root, 'bob-data'))
    expect(() => new MaterialsService(repo, [
      { id: 'grant-a', scope, label: 'Synthetic experiment files', rootPath: root },
      { id: 'grant-b', scope: { kind: 'personal', ownerId: 'bob' }, label: 'Bob synthetic', rootPath: join(root, 'bob-data') },
    ])).toThrow('Research access denied.')
    const shared = new MaterialsService(repo, [
      { id: 'grant-a', scope, label: 'Synthetic experiment files', rootPath: root },
      { id: 'grant-b', scope: { kind: 'personal', ownerId: 'bob' }, label: 'Bob synthetic', rootPath: root },
    ])
    expect(shared.registerRoot(bob, 'grant-b', '').scope).toEqual({ kind: 'personal', ownerId: 'bob' })
    expect(() => shared.registerRoot(bob, 'grant-a', '')).toThrow('Research access denied.')
  })
  test('completed snapshots use natural numeric names, cursor pages and detect directory changes', async () => {
    for (const name of ['frame10.png', 'frame2.png', 'frame1.png']) writeFileSync(join(root, name), 'synthetic image bytes')
    const material = service.registerRoot(alice, 'grant-a', '')
    await service.indexDirectory(alice, material.id)
    const first = service.list(alice, material.id, '', 2)
    expect(first.items.map(entry => entry.name)).toEqual(['frame1.png', 'frame2.png'])
    expect(service.list(alice, material.id, '', 2, first.nextCursor).items.map(entry => entry.name)).toEqual(['frame10.png'])
    writeFileSync(join(root, 'frame3.png'), 'synthetic image bytes')
    expect(() => service.list(alice, material.id, '', 2, first.nextCursor)).toThrow()
  })
  test('bounded keyword search is local and inherits restricted policy without changing originals', async () => {
    writeFileSync(join(root, 'notes.txt'), 'Synthetic migration experiment: alpha marker')
    const material = service.registerRoot(alice, 'grant-a', '')
    await service.indexDirectory(alice, material.id)
    const matches = await service.searchText(alice, material.id, 'alpha')
    expect(matches.matches.length).toBe(1); expect(matches.matches[0]?.snippet).toContain('alpha')
    expect(matches.truncated).toBe(false)
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('Synthetic migration experiment: alpha marker')
  })
  test('bounded text searches explicitly report partial results and normalize keywords', async () => {
    for (let n = 0; n < 65; n++) writeFileSync(join(root, `notes${n}.txt`), 'alpha')
    const material = service.registerRoot(alice, 'grant-a', '')
    await service.indexDirectory(alice, material.id)
    const result = await service.searchText(alice, material.id, ' alpha ')
    expect(result.matches).toHaveLength(64); expect(result.filesRead).toBe(64)
    expect(result.truncated).toBe(true); expect(result.policy).toBe('restricted')
  })
  test('a stale index completion cannot replace a newer generation', () => {
    const material = service.registerRoot(alice, 'grant-a', '')
    const state = { key: 'a'.repeat(64), relativeDir: '', generation: 1, status: 'indexing' as const, signature: 'synthetic', count: 0 }
    repo.beginMaterialDirectory(alice, material.id, state)
    repo.beginMaterialDirectory(alice, material.id, { ...state, generation: 2 })
    expect(() => repo.completeMaterialDirectory(alice, material.id, { ...state, status: 'complete' })).toThrow('The revision has changed.')
  })
  test('file replacement during open is rejected before content reads', async () => {
    const file = join(root, 'notes.txt'); writeFileSync(file, 'synthetic original alpha')
    let reads = 0
    service = new MaterialsService(repo, [{ id: 'grant-a', scope, label: 'Synthetic experiment files', rootPath: root }], {
      openFile: async (path, flags) => {
        renameSync(file, join(root, 'old.txt')); writeFileSync(file, 'synthetic replacement alpha')
        const handle = await open(path, flags), read = handle.read.bind(handle)
        handle.read = ((...args: Parameters<typeof handle.read>) => { reads++; return read(...args) }) as typeof handle.read
        return handle
      },
    })
    const material = service.registerRoot(alice, 'grant-a', ''); await service.indexDirectory(alice, material.id)
    await expect(service.searchText(alice, material.id, 'alpha')).rejects.toThrow('The revision has changed.')
    expect(reads).toBe(0)
  })
  test('a later file changing while an earlier file is read invalidates the original completed snapshot', async () => {
    writeFileSync(join(root, 'a.txt'), 'alpha'); writeFileSync(join(root, 'b.txt'), 'original alpha')
    service = new MaterialsService(repo, [{ id: 'grant-a', scope, label: 'Synthetic experiment files', rootPath: root }], {
      openFile: async (path, flags) => {
        const handle = await open(path, flags), read = handle.read.bind(handle)
        if (String(path).endsWith('a.txt')) handle.read = (async (...args: Parameters<typeof handle.read>) => {
          writeFileSync(join(root, 'b.txt'), 'changed synthetic alpha'); return read(...args)
        }) as typeof handle.read
        return handle
      },
    })
    const material = service.registerRoot(alice, 'grant-a', ''); await service.indexDirectory(alice, material.id)
    await expect(service.searchText(alice, material.id, 'alpha')).rejects.toThrow('The revision has changed.')
  })
  test('image names are searchable without parsing image contents', async () => {
    writeFileSync(join(root, 'alpha-cell.png'), 'synthetic')
    const material = service.registerRoot(alice, 'grant-a', ''); await service.indexDirectory(alice, material.id)
    expect((await service.searchText(alice, material.id, 'alpha')).matches[0]?.name).toBe('alpha-cell.png')
  })
  test('configured entry budget exposes failure and progress without publishing incomplete pages', async () => {
    for (let n = 0; n < 3; n++) writeFileSync(join(root, `frame${n}.png`), 'synthetic')
    service = new MaterialsService(repo, [{ id: 'grant-a', scope, label: 'Synthetic experiment files', rootPath: root }], { budgets: { maxEntries: 2 } })
    const material = service.registerRoot(alice, 'grant-a', '')
    await expect(service.indexDirectory(alice, material.id)).rejects.toThrow()
    const state = service.indexState(alice, material.id, '')
    expect(state.status).toBe('failed'); expect(state.reason).toBe('budget'); expect(state.count).toBe(2)
    expect(() => service.list(alice, material.id)).toThrow('The revision has changed.')
  })
  test('search deadline also bounds directories containing only image metadata', async () => {
    for (let n = 0; n < 10; n++) writeFileSync(join(root, `frame${n}.png`), 'synthetic')
    let ticks = 0
    service = new MaterialsService(repo, [{ id: 'grant-a', scope, label: 'Synthetic experiment files', rootPath: root }], {
      now: () => ++ticks, budgets: { searchMs: 3 },
    })
    const material = service.registerRoot(alice, 'grant-a', ''); await service.indexDirectory(alice, material.id)
    expect((await service.searchText(alice, material.id, 'unknown')).truncated).toBe(true)
  })
  test('different directories cannot run parallel scans, and a disconnected root retains its entry', async () => {
    mkdirSync(join(root, 'first')); mkdirSync(join(root, 'second'))
    const first = service.registerRoot(alice, 'grant-a', 'first'), second = service.registerRoot(alice, 'grant-a', 'second')
    const task = service.indexDirectory(alice, first.id)
    await expect(service.indexDirectory(alice, second.id)).rejects.toThrow()
    await task; renameSync(join(root, 'first'), join(root, 'offline-first'))
    expect(service.getRoot(alice, first.id).id).toBe(first.id)
    expect(() => service.list(alice, first.id)).toThrow('Research storage is unavailable.')
    await service.indexDirectory(alice, second.id)
  })
  test('authority revoked during opening blocks the read and releases the handle', async () => {
    writeFileSync(join(root, 'notes.txt'), 'synthetic alpha'); let active = true, reads = 0
    service = new MaterialsService(repo, [{ id: 'grant-a', scope, label: 'Synthetic experiment files', rootPath: root }], {
      currentActor: actor => { if (!active) throw Error('Synthetic revoked authority'); return actor },
      openFile: async (path, flags) => {
        const file = await open(path, flags), read = file.read.bind(file); active = false
        file.read = ((...args: Parameters<typeof file.read>) => { reads++; return read(...args) }) as typeof file.read
        return file
      },
    })
    const material = service.registerRoot(alice, 'grant-a', ''); await service.indexDirectory(alice, material.id)
    await expect(service.searchText(alice, material.id, 'alpha')).rejects.toThrow('Synthetic revoked authority')
    expect(reads).toBe(0)
  })
  test('private notes and tags are stored in the platform, searchable, and revision guarded', async () => {
    const path = join(root, 'frame1.png'); writeFileSync(path, 'synthetic original')
    const material = service.registerRoot(alice, 'grant-a', ''); await service.indexDirectory(alice, material.id)
    const page = service.list(alice, material.id), fileId = page.items[0]!.id
    const note = service.saveAnnotation(alice, material.id, '', page.generation, fileId, 0, 'Synthetic migration note', ['movement'])
    expect(note.revision).toBe(1); expect(note.policy).toBe('restricted')
    expect((await service.searchText(alice, material.id, 'movement')).matches[0]?.fileId).toBe(fileId)
    expect(() => service.saveAnnotation(alice, material.id, '', page.generation, fileId, 0, 'stale', [])).toThrow('The revision has changed.')
    expect(readFileSync(path, 'utf8')).toBe('synthetic original')
  })
  test('complete indexes, notes and root bindings survive an authority restart; removing a grant revokes access', async () => {
    const database = join(resolveConfigDir(), `t08-${crypto.randomUUID()}.sqlite`)
    repo.close(); repo = new SqliteResearchRepository(database)
    for (const actor of [alice, bob]) repo.seedUser({ id: actor.userId, username: actor.userId, passwordHash: 'synthetic-hash', active: true, administrator: actor.administrator, revision: 1 })
    const grants = [{ id: 'grant-a', scope, label: 'Synthetic experiment files', rootPath: root }]
    service = new MaterialsService(repo, grants); writeFileSync(join(root, 'notes.txt'), 'synthetic alpha')
    const material = service.registerRoot(alice, 'grant-a', ''); await service.indexDirectory(alice, material.id)
    const page = service.list(alice, material.id), id = page.items[0]!.id
    service.saveAnnotation(alice, material.id, '', page.generation, id, 0, 'synthetic persisted note', ['saved'])
    repo.close(); repo = new SqliteResearchRepository(database)
    service = new MaterialsService(repo, grants)
    expect(service.listRoots(alice, scope, 100).items[0]?.id).toBe(material.id)
    expect(service.annotation(alice, material.id, '', page.generation, id).note).toBe('synthetic persisted note')
    new MaterialsService(repo, [])
    expect(() => service.list(alice, material.id)).toThrow('Research access denied.')
  })
  test('metadata indexing and all pages of ten thousand images never open original contents', async () => {
    for (let n = 0; n < 10000; n++) writeFileSync(join(root, `frame${n}.png`), 'synthetic image')
    let opens = 0
    service = new MaterialsService(repo, [{ id: 'grant-a', scope, label: 'Synthetic experiment files', rootPath: root }], {
      openFile: async (...args) => { opens++; return open(...args) },
    })
    const material = service.registerRoot(alice, 'grant-a', ''); await service.indexDirectory(alice, material.id)
    let cursor: string | undefined, count = 0
    do {
      const page = service.list(alice, material.id, '', 200, cursor)
      expect(page.items.length).toBeLessThanOrEqual(200)
      for (const entry of page.items) { expect(entry.name).toBe(`frame${count}.png`); count++ }
      cursor = page.nextCursor
    } while (cursor)
    expect(count).toBe(10000); expect(opens).toBe(0)
    expect((await service.searchText(alice, material.id, 'alpha')).filesRead).toBe(0); expect(opens).toBe(0)
  }, 60000)
})
