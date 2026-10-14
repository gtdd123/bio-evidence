import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { resolve, join, relative, sep, isAbsolute } from 'node:path'
import { SqliteResearchRepository } from './sqlite-repository'
import { createBioAuthorityServer } from './authority-server'
import { registerResearchRpcProfile } from './rpc-profile'
import { LiteratureService } from './literature-service'
import { MaterialsService } from './materials-service'
import { DocumentParseService } from './document-parse'
import { SourceSnapshotService } from './source-snapshots'
import { createDocumentsHttpAdapter } from './documents-http'
import { RESEARCH_CHANNELS as R } from '@bio-evidence/research-core'
import { createConnection } from 'node:net'
// A self-contained generated PDF. The second page is empty, so coverage must stay partial.
function pdf(): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    '<< /Length 58 >>\nstream\nBT /F1 12 Tf 30 700 Td (Synthetic public evidence) Tj ET\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 7 0 R >>', '<< /Length 0 >>\nstream\n\nendstream']
  let body = '%PDF-1.7\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const at = Buffer.byteLength(body)
  body += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`
  return Uint8Array.from(Buffer.from(body))
}
let repo: SqliteResearchRepository, server: Awaited<ReturnType<typeof createBioAuthorityServer>>,
  login: Awaited<ReturnType<typeof server.auth.login>>, snapshots: SourceSnapshotService, materials: MaterialsService,
  profile: ReturnType<typeof registerResearchRpcProfile>, root: string
beforeEach(async () => {
  mkdirSync(resolve('.fixtures'), { recursive: true }); root = mkdtempSync(resolve('.fixtures/t11-http-'))
  let http: ReturnType<typeof createDocumentsHttpAdapter> | undefined
  repo = new SqliteResearchRepository(); server = await createBioAuthorityServer(repo, { port: 0, additionalHttpHandler: (req, res) => http?.(req, res) ?? false })
  await server.auth.createAccount(null, 'alice', 'Synthetic-password-9!', true); login = await server.auth.login('alice', 'Synthetic-password-9!')
  const currentActor = (actor: typeof login.actor) => { const current = server.auth.resolveActor(actor.authSessionId); if (!current) throw Error('revoked'); return current }
  const scope = { kind: 'personal', ownerId: login.actor.userId } as const
  repo.put(login.actor, 'session', { id: 'session-a', ownerId: login.actor.userId, scope, policy: 'public', name: 'Papers', revision: 1, createdAt: 1 })
  materials = new MaterialsService(repo, [{ id: 'grant-a', scope, label: 'Synthetic PDF folder', rootPath: root }], { currentActor })
  const literature = new LiteratureService(repo, { search: async () => ({ items: [] }), record: async () => { throw Error('unused') },
    openText: async () => new TextEncoder().encode('<article><body><sec><title>Results</title><p>Retrieved text.</p><fig><caption>Unparsed figure</caption></fig></sec></body></article>') }, { currentActor })
  snapshots = new SourceSnapshotService(repo, literature, new DocumentParseService(), { currentActor, materials })
  profile = registerResearchRpcProfile(server.server, repo, materials, undefined, literature, snapshots)
  http = createDocumentsHttpAdapter(snapshots, server.auth, server.boundary); await server.server.listen()
})
afterEach(async () => {
  server.server.close(); await snapshots.close(); repo.close()
  const offset = relative(realpathSync.native(resolve('.fixtures')), realpathSync.native(root))
  if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned cleanup boundary')
  rmSync(root, { recursive: true, force: true })
})
test('authenticated binary upload parses real PDF with explicit declaration and actual page gaps', async () => {
  const response = await fetch(`${server.boundary.publicOrigin}/api/research/sessions/session-a/pdf?expectedRevision=1&declaredPublic=true`, {
    method: 'POST', headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/pdf' }, body: pdf(),
  })
  expect(response.status).toBe(200)
  const result = await response.json() as any
  expect(result.status).toBe('ok'); expect(result.source.declaration.actorId).toBe(login.actor.userId)
  expect(result.snapshot.acquiredBy).toBe('declared-public-pdf'); expect(result.snapshot.coverage.level).toBe('partial')
  expect(result.snapshot.blocks[0].locator).toEqual({ kind: 'pdf-page', page: 1 })
  expect(result.snapshot.blocks[0].text).toBe('Synthetic public evidence')
  expect(repo.get(login.actor, 'snapshot', result.snapshot.id)).toEqual(result.snapshot)
}, 15000)
test('browser upload requires same-origin mutation; body budget and unknown query fail closed', async () => {
  const url = `${server.boundary.publicOrigin}/api/research/sessions/session-a/pdf?expectedRevision=1`
  expect((await fetch(url, { method: 'POST', headers: { Cookie: server.boundary.cookie(login.token), 'Content-Type': 'application/pdf' }, body: pdf() })).status).toBe(403)
  expect((await fetch(url + '&policy=public', { method: 'POST', headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/pdf' }, body: pdf() })).status).toBe(400)
  const tooLarge = await new Promise<number>((resolve, reject) => {
    const target = new URL(url), socket = createConnection({ host: '127.0.0.1', port: Number(target.port) })
    socket.setTimeout(3000, () => { socket.destroy(); reject(Error('Synthetic HTTP deadline')) })
    socket.once('connect', () => socket.write(`POST ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nAuthorization: Bearer ${login.token}\r\nContent-Type: application/pdf\r\nContent-Length: ${25 * 1024 * 1024 + 1}\r\nConnection: close\r\n\r\n`))
    socket.once('data', data => { resolve(Number(data.toString().split(' ')[1])); socket.destroy() }); socket.on('error', reject)
  })
  expect(tooLarge).toBe(413)
})
test('controlled local PDF parsing stays private and public JATS adds a truthful immutable snapshot', async () => {
  writeFileSync(join(root, 'paper.pdf'), pdf())
  const material = materials.registerRoot(login.actor, 'grant-a', ''); await materials.indexDirectory(login.actor, material.id)
  const page = materials.list(login.actor, material.id, '', 100)
  const result = await profile.dispatch(login.actor, R.IMPORT_MATERIAL_PDF, { sessionId: 'session-a', expectedRevision: 1, rootId: material.id, fileId: page.items[0]!.id, generation: page.generation }, current => current) as any
  expect(result.status).toBe('ok'); expect(result.source.policy).toBe('restricted'); expect(result.snapshot.acquiredBy).toBe('private-pdf')
  const scope = material.scope
  repo.put(login.actor, 'source', { id: 'oa-source', scope, policy: 'public', provider: 'europe-pmc', identifiers: { pmcid: 'PMC123' }, availability: { fullText: true }, license: { status: 'unknown' }, createdAt: 1 })
  repo.put(login.actor, 'session', { id: 'public-session', ownerId: login.actor.userId, scope, policy: 'public', selectedSourceIds: ['oa-source'], name: 'Public', revision: 1, createdAt: 1 })
  const read = await profile.dispatch(login.actor, R.READ_SOURCE_TEXT, { sessionId: 'public-session', sourceId: 'oa-source' }, current => current) as any
  expect(read.status).toBe('ok'); expect(read.snapshot.format).toBe('jats'); expect(read.snapshot.coverage.level).toBe('partial')
  expect(read.snapshot.blocks.map((block: any) => block.text)).toEqual(['Results', 'Retrieved text.'])
  const again = await profile.dispatch(login.actor, R.READ_SOURCE_TEXT, { sessionId: 'public-session', sourceId: 'oa-source' }, current => current) as any
  expect(again.snapshot.id).not.toBe(read.snapshot.id); expect(repo.get(login.actor, 'snapshot', read.snapshot.id)).toEqual(read.snapshot)
  expect(() => profile.gate.authorizeRequest(login.actor, R.IMPORT_MATERIAL_PDF, [{ sessionId: 'session-a', expectedRevision: 2, rootId: material.id, fileId: page.items[0]!.id, generation: page.generation, declaredPublic: true }])).toThrow()
}, 15000)
