import { afterEach, beforeEach, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import WebSocket from 'ws'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { SqliteResearchRepository } from './sqlite-repository'
import { MaterialsService } from './materials-service'
import { createBioAuthorityServer } from './authority-server'
import { registerResearchRpcProfile } from './rpc-profile'
import { inside } from './material-paths'
import { createMaterialsHttpAdapter } from './materials-http'
import sharp from 'sharp'
import { MaterialPreviewService } from './material-preview'
import { deserializeEnvelope } from '../transport/codec'
let root: string, repo: SqliteResearchRepository, instance: Awaited<ReturnType<typeof createBioAuthorityServer>>
let alice: Awaited<ReturnType<typeof instance.auth.login>>, bob: typeof alice, materials: MaterialsService
const sockets: WebSocket[] = [], scope = { kind: 'project', projectId: 'project-a' } as const
beforeEach(async () => {
  mkdirSync(resolve('.fixtures'), { recursive: true }); root = mkdtempSync(resolve('.fixtures/t08-rpc-'))
  let http: ReturnType<typeof createMaterialsHttpAdapter> | undefined
  repo = new SqliteResearchRepository(); instance = await createBioAuthorityServer(repo, { port: 0, additionalHttpHandler: (req, res) => http?.(req, res) ?? false })
  await instance.auth.createAccount(null, 'alice', 'Synthetic-password-9!', true); alice = await instance.auth.login('alice', 'Synthetic-password-9!')
  await instance.auth.createAccount(alice.actor, 'bob', 'Synthetic-password-9!'); bob = await instance.auth.login('bob', 'Synthetic-password-9!')
  repo.createProject(alice.actor, 'project-a', 'Project A'); repo.setMember(alice.actor, 'project-a', bob.account.id, 'viewer', true, 1)
  materials = new MaterialsService(repo, [{ id: 'grant-a', scope, label: 'Synthetic local data', rootPath: root }], { currentActor: actor => {
    const current = instance.auth.resolveActor(actor.authSessionId)
    if (!current || current.userId !== actor.userId) throw Error('Authentication required')
    return current
  } })
  const previews = new MaterialPreviewService(materials), profile = registerResearchRpcProfile(instance.server, repo, materials, previews)
  http = createMaterialsHttpAdapter(profile, instance.auth, instance.boundary, { materials, previews }); await instance.server.listen()
})
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate()
  instance.server.close(); repo.close()
  if (!inside(realpathSync.native(resolve('.fixtures')), realpathSync.native(root)) || root === resolve('.fixtures')) throw Error('Owned cleanup boundary')
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})
async function connect(login: typeof alice) {
  const ws = new WebSocket(`ws://127.0.0.1:${instance.server.port}`); sockets.push(ws); ws.on('error', () => {})
  await new Promise<void>(resolve => {
    ws.once('open', () => ws.send(JSON.stringify({ id: 'auth', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: login.token })))
    ws.once('message', () => resolve())
  }); return ws
}
async function invoke(ws: WebSocket, name: string, input: unknown) {
  return await new Promise<any>(resolve => {
    ws.once('message', data => resolve(deserializeEnvelope(data.toString())))
    ws.send(JSON.stringify({ id: crypto.randomUUID(), type: 'request', channel: `research:v1:${name}`, args: [input] }))
  })
}
test('material RPC registers only deployment subdirectories and returns restricted metadata, never absolute paths', async () => {
  const ws = await connect(alice)
  const grants = await invoke(ws, 'listMaterialGrants', { scope })
  expect(grants.error).toBeUndefined(); expect(grants.result).toEqual([{ id: 'grant-a', scope, label: 'Synthetic local data' }])
  const registration = await invoke(ws, 'registerMaterial', { grantId: 'grant-a', relativeDir: '' })
  expect(registration.error).toBeUndefined(); expect(registration.result.policy).toBe('restricted')
  expect(JSON.stringify(registration.result)).not.toContain(root)
  expect((await invoke(ws, 'registerMaterial', { grantId: 'grant-a', relativeDir: '', rootPath: root })).error).toBeDefined()
  expect((await invoke(await connect(bob), 'registerMaterial', { grantId: 'grant-a', relativeDir: '' })).error).toBeDefined()
})
test('real authenticated material channels browse/index/search and reject current revoked membership', async () => {
  writeFileSync(join(root, 'notes.txt'), 'Synthetic alpha experiment')
  const material = materials.registerRoot(alice.actor, 'grant-a', ''), ws = await connect(bob)
  expect((await invoke(ws, 'indexMaterialDirectory', { rootId: material.id })).error).toBeUndefined()
  const page = await invoke(ws, 'listMaterialDirectory', { rootId: material.id })
  expect(page.error).toBeUndefined(); expect(page.result.items[0].name).toBe('notes.txt')
  const search = await invoke(ws, 'searchMaterialText', { rootId: material.id, query: 'alpha' })
  expect(search.error).toBeUndefined(); expect(search.result.matches).toHaveLength(1)
  repo.setMember(alice.actor, 'project-a', bob.account.id, 'viewer', false, 2)
  expect((await invoke(ws, 'listMaterialDirectory', { rootId: material.id })).error).toBeDefined()
  expect((await invoke(ws, 'searchMaterialText', { rootId: material.id, query: 'alpha' })).error).toBeDefined()
})
test('material HTTP metadata uses the same current root authority and excludes file paths', async () => {
  const material = materials.registerRoot(alice.actor, 'grant-a', '')
  const url = `http://127.0.0.1:${instance.server.port}/api/materials/${material.id}`
  const response = await fetch(url, { headers: { Authorization: `Bearer ${bob.token}` } })
  expect(response.status).toBe(200); expect((await response.json() as { id: string }).id).toBe(material.id)
  expect(response.headers.get('cache-control')).toBe('no-store')
  repo.setMember(alice.actor, 'project-a', bob.account.id, 'viewer', false, 2)
  expect((await fetch(url, { headers: { Authorization: `Bearer ${bob.token}` } })).status).toBe(403)
  expect((await fetch(url)).status).toBe(401)
  expect((await fetch(url, { headers: { Authorization: `Bearer ${alice.token}`, Origin: 'https://synthetic-other.invalid' } })).status).toBe(403)
})
test('annotations require an editing role and cannot move a file identifier between roots', async () => {
  writeFileSync(join(root, 'notes.txt'), 'synthetic alpha')
  const first = materials.registerRoot(alice.actor, 'grant-a', ''), second = materials.registerRoot(alice.actor, 'grant-a', '')
  await materials.indexDirectory(alice.actor, first.id); await materials.indexDirectory(alice.actor, second.id)
  const page = materials.list(alice.actor, first.id), fileId = page.items[0]!.id
  const input = { rootId: first.id, fileId, generation: page.generation, expectedRevision: 0, note: 'Synthetic note', tags: ['migration'] }
  const viewer = await connect(bob), owner = await connect(alice)
  expect((await invoke(viewer, 'saveMaterialAnnotation', input)).error).toBeDefined()
  expect((await invoke(owner, 'saveMaterialAnnotation', { ...input, rootId: second.id })).error).toBeDefined()
  const saved = await invoke(owner, 'saveMaterialAnnotation', input)
  expect(saved.error).toBeUndefined(); expect(saved.result.revision).toBe(1)
  expect((await invoke(viewer, 'getMaterialAnnotation', { rootId: first.id, fileId, generation: page.generation })).result.note).toBe('Synthetic note')
})
test('authenticated HTTP image preview and original download are bound to a selected file', async () => {
  const input = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#56a1dc' } }).png().toBuffer()
  writeFileSync(join(root, 'frame1.png'), input)
  const material = materials.registerRoot(alice.actor, 'grant-a', ''); await materials.indexDirectory(alice.actor, material.id)
  const page = materials.list(alice.actor, material.id), fileId = page.items[0]!.id
  const endpoint = `http://127.0.0.1:${instance.server.port}/api/materials/${material.id}?fileId=${fileId}&generation=${page.generation}`
  const headers = { Authorization: `Bearer ${bob.token}` }
  const preview = await fetch(`${endpoint}&view=preview&kind=thumbnail`, { headers })
  expect(preview.status).toBe(200); expect(preview.headers.get('content-type')).toBe('image/png')
  expect((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width).toBe(256)
  const original = await fetch(`${endpoint}&view=download`, { headers })
  expect(original.status).toBe(200); expect(original.headers.get('content-disposition')).toContain('attachment')
  expect(Buffer.from(await original.arrayBuffer()).equals(input)).toBe(true)
  repo.setMember(alice.actor, 'project-a', bob.account.id, 'viewer', false, 2)
  expect((await fetch(`${endpoint}&view=preview`, { headers })).status).toBe(403)
  expect((await fetch(`${endpoint}&view=download`, { headers })).status).toBe(403)
})
test('membership revoked during a real HTTP original stream prevents complete delivery', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 72); writeFileSync(join(root, 'large.bin'), bytes)
  const material = materials.registerRoot(alice.actor, 'grant-a', ''); await materials.indexDirectory(alice.actor, material.id)
  const page = materials.list(alice.actor, material.id)
  const response = await fetch(`http://127.0.0.1:${instance.server.port}/api/materials/${material.id}?view=download&generation=${page.generation}&fileId=${page.items[0]!.id}`, { headers: { Authorization: `Bearer ${bob.token}` } })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader(), first = await reader.read()
  let received = first.value?.length ?? 0, interrupted = false
  expect(received).toBeGreaterThan(0)
  repo.setMember(alice.actor, 'project-a', bob.account.id, 'viewer', false, 2)
  try { while (true) { const result = await reader.read(); if (result.done) break; received += result.value.length } } catch { interrupted = true }
  finally { reader.releaseLock() }
  expect(interrupted).toBe(true); expect(received).toBeLessThan(bytes.length)
}, 10000)
test('shared authenticated RPC exposes frame metadata and bounded previews for the exact selected file', async () => {
  writeFileSync(join(root, 'frame1.png'), await sharp({ create: { width: 800, height: 400, channels: 3, background: '#56a1dc' } }).png().toBuffer())
  const material = materials.registerRoot(alice.actor, 'grant-a', ''); await materials.indexDirectory(alice.actor, material.id)
  const page = materials.list(alice.actor, material.id), ws = await connect(bob)
  const input = { rootId: material.id, fileId: page.items[0]!.id, generation: page.generation }
  const info = await invoke(ws, 'getMaterialImage', input)
  expect(info.error).toBeUndefined(); expect(info.result.width).toBe(800); expect(info.result.pages).toBe(1)
  const preview = await invoke(ws, 'getMaterialImage', { ...input, kind: 'thumbnail' })
  expect(preview.error).toBeUndefined(); expect(preview.result.width).toBe(256); expect(preview.result.bytes).toBeDefined()
  expect(preview.result.bytes).toBeInstanceOf(Uint8Array)
  expect((await sharp(preview.result.bytes).metadata()).format).toBe('png')
  expect((await invoke(ws, 'getMaterialImage', { ...input, fileId: 'unknown' })).error).toBeDefined()
})
