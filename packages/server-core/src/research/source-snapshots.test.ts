import { expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { LiteratureService } from './literature-service'
import { SourceSnapshotService } from './source-snapshots'
import { DocumentParseService } from './document-parse'
import type { Actor } from '@bio-evidence/research-core'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { resolve, join, relative, sep, isAbsolute } from 'node:path'
import { MaterialsService } from './materials-service'
const actor = { userId: 'alice', authSessionId: 'auth-alice', active: true, administrator: false }
const scope = { kind: 'personal', ownerId: 'alice' } as const
function setup(parser: DocumentParseService, currentActor?: (actor: Actor) => Actor, materialRoot?: string) {
  const repo = new SqliteResearchRepository()
  repo.seedUser({ id: 'alice', username: 'alice', passwordHash: 'synthetic', active: true, administrator: false, revision: 1 })
  repo.put(actor, 'session', { id: 'session-a', ownerId: 'alice', scope, policy: 'public', name: 'Research', revision: 1, createdAt: 1 })
  const literature = new LiteratureService(repo, { search: async () => ({ items: [] }), record: async () => { throw Error('unused') }, openText: async () => { throw Error('unused') } })
  const materials = materialRoot ? new MaterialsService(repo, [{ id: 'grant', scope, label: 'Synthetic folder', rootPath: materialRoot }]) : undefined
  return { repo, materials, snapshots: new SourceSnapshotService(repo, literature, parser, { currentActor, materials }) }
}
class SyntheticParser extends DocumentParseService {
  override async parse() { return { status: 'ok' as const, format: 'pdf' as const, coverage: { level: 'partial' as const, totalUnits: 2, units: [{ unit: 1, status: 'read' as const }, { unit: 2, status: 'no-text' as const, reason: 'scan-or-empty' as const }] }, blocks: [{ id: 'pdf-page-1', unit: 1, text: 'Synthetic text', locator: { kind: 'pdf-page' as const, page: 1 } }] } }
}
test('parsed private PDF and truthful page coverage commit atomically with source selection', async () => {
  const parser = new SyntheticParser(), { repo, snapshots } = setup(parser)
  try {
    const result = await snapshots.importPdf(actor, { sessionId: 'session-a', expectedRevision: 1, bytes: new TextEncoder().encode('synthetic pdf') })
    expect(result.status).toBe('ok'); if (result.status !== 'ok') throw Error('missing snapshot')
    expect(result.snapshot.policy).toBe('restricted'); expect(result.snapshot.acquiredBy).toBe('private-pdf')
    expect(result.snapshot.coverage.level).toBe('partial'); expect(result.session.policy).toBe('restricted')
    expect(repo.get(actor, 'snapshot', result.snapshot.id)).toEqual(result.snapshot)
  } finally { repo.close(); await parser.close() }
})
test('snapshot insertion failure rolls back the PDF source and session selection', async () => {
  const parser = new SyntheticParser(), { repo, snapshots } = setup(parser)
  try {
    const db = (repo as unknown as { db: import('bun:sqlite').Database }).db
    db.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON snapshot_blocks BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    await expect(snapshots.importPdf(actor, { sessionId: 'session-a', expectedRevision: 1, bytes: new Uint8Array([1]) })).rejects.toThrow()
    expect(repo.sourceHeads(actor, scope)).toHaveLength(0); expect(repo.get(actor, 'session', 'session-a')).toMatchObject({ revision: 1 })
  } finally { await snapshots.close(); repo.close() }
})
test('current auth and session version are checked after parsing, with no late writes', async () => {
  let release!: () => void, live = true
  const wait = new Promise<void>(resolve => { release = resolve })
  class DelayedParser extends SyntheticParser { override async parse() { await wait; return super.parse() } }
  const parser = new DelayedParser(), { repo, snapshots } = setup(parser, current => { if (!live) throw Error('revoked'); return current })
  try {
    const result = snapshots.importPdf(actor, { sessionId: 'session-a', expectedRevision: 1, bytes: new Uint8Array([1]) }); live = false; release()
    await expect(result).rejects.toThrow(); expect(repo.sourceHeads(actor, scope)).toHaveLength(0)
  } finally { release(); repo.close(); await parser.close() }
})
test('a concurrent session edit rejects the parsed result without a source write', async () => {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  class Delayed extends SyntheticParser { override async parse() { await wait; return super.parse() } }
  const parser = new Delayed(), { repo, snapshots } = setup(parser)
  try {
    const pending = snapshots.importPdf(actor, { sessionId: 'session-a', expectedRevision: 1, bytes: new Uint8Array([1]) })
    repo.put(actor, 'session', { ...repo.get(actor, 'session', 'session-a'), name: 'Concurrent edit', revision: 2 }, 1)
    release(); await expect(pending).rejects.toThrow('The revision has changed.'); expect(repo.sourceHeads(actor, scope)).toHaveLength(0)
  } finally { release(); await snapshots.close(); repo.close() }
})
for (const change of ['file', 'account'] as const) test(`local PDF ${change} change after reading refuses the late parsed result`, async () => {
  mkdirSync(resolve('.fixtures'), { recursive: true }); const root = mkdtempSync(resolve('.fixtures/t11-late-'))
  let release!: () => void, entered!: () => void
  const wait = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  class Delayed extends SyntheticParser { override async parse() { entered(); await wait; return super.parse() } }
  const parser = new Delayed(), { repo, snapshots, materials } = setup(parser, undefined, root)
  try {
    if (!materials) throw Error('missing materials')
    writeFileSync(join(root, 'synthetic.pdf'), 'synthetic PDF bytes')
    const material = materials.registerRoot(actor, 'grant', ''); await materials.indexDirectory(actor, material.id)
    const page = materials.list(actor, material.id, '', 100), before = repo.counts().outbox
    const pending = snapshots.importMaterialPdf(actor, { sessionId: 'session-a', expectedRevision: 1, rootId: material.id, generation: page.generation, relativeDir: '', fileId: page.items[0]!.id })
    await ready
    if (change === 'file') writeFileSync(join(root, 'synthetic.pdf'), 'changed synthetic PDF bytes with different length')
    else {
      const admin = { userId: 'admin', authSessionId: 'auth-admin', active: true, administrator: true }
      repo.seedUser({ id: 'admin', username: 'admin', passwordHash: 'synthetic', active: true, administrator: true, revision: 1 }); repo.setAccountActive(admin, actor.userId, false, 1)
    }
    release(); await expect(pending).rejects.toThrow(); expect(repo.counts().outbox).toBe(before)
  } finally {
    release(); await snapshots.close(); repo.close()
    const offset = relative(realpathSync.native(resolve('.fixtures')), realpathSync.native(root))
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned cleanup boundary')
    rmSync(root, { recursive: true, force: true })
  }
})
