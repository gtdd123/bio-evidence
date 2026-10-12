import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import WebSocket from 'ws'
import { RESEARCH_CHANNELS as R } from '@bio-evidence/research-core'
import { PROTOCOL_VERSION, getAllChannelValues } from '@craft-agent/shared/protocol'
import { SqliteResearchRepository } from './sqlite-repository'
import { createBioAuthorityServer } from './authority-server'
import { registerResearchRpcProfile } from './rpc-profile'
const password = 'Synthetic-passphrase-9!'
describe('authoritative personal/project RPC profile', () => {
  let repo: SqliteResearchRepository, instance: Awaited<ReturnType<typeof createBioAuthorityServer>>
  let alice: Awaited<ReturnType<typeof instance.auth.login>>, bob: typeof alice, charlie: typeof alice
  const sockets: WebSocket[] = []
  let privateId: string, projectA: string, projectB: string
  let profile: ReturnType<typeof registerResearchRpcProfile>
  beforeEach(async () => {
    repo = new SqliteResearchRepository(); instance = await createBioAuthorityServer(repo, { port: 0 })
    await instance.auth.createAccount(null, 'alice', password, true); alice = await instance.auth.login('alice', password)
    await instance.auth.createAccount(alice.actor, 'bob', password); await instance.auth.createAccount(alice.actor, 'charlie', password)
    bob = await instance.auth.login('bob', password); charlie = await instance.auth.login('charlie', password)
    privateId = 'bob-private-session'; projectA = 'project-a'; projectB = 'project-b'
    repo.createProject(alice.actor, projectA, 'Project A'); repo.setMember(alice.actor, projectA, bob.account.id, 'viewer', true, 1)
    repo.createProject(charlie.actor, projectB, 'Project B')
    repo.put(bob.actor, 'session', { id: privateId, ownerId: bob.account.id, scope: { kind: 'personal', ownerId: bob.account.id },
      policy: 'restricted', name: 'Synthetic private note', revision: 1, createdAt: 1 })
    profile = registerResearchRpcProfile(instance.server, repo); await instance.server.listen()
  })
  afterEach(() => { for (const ws of sockets.splice(0)) ws.terminate(); instance.server.close(); repo.close() })
  async function connect(login: typeof alice, workspaceId?: string, options: { reconnectClientId?: string; frames?: any[]; capabilities?: string[] } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${instance.server.port}`); sockets.push(ws); ws.on('error', () => {})
    if (options.frames) ws.on('message', data => options.frames!.push(JSON.parse(data.toString())))
    await new Promise<void>(resolve => {
      ws.once('open', () => ws.send(JSON.stringify({ id: 'a', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: login.token, workspaceId,
        reconnectClientId: options.reconnectClientId, lastSeq: options.reconnectClientId ? 0 : undefined, clientCapabilities: options.capabilities })))
      ws.once('message', () => resolve())
    }); return ws
  }
  async function invoke(ws: WebSocket, channel: string, input: unknown) {
    return await new Promise<any>(resolve => {
      ws.once('message', data => resolve(JSON.parse(data.toString())))
      ws.send(JSON.stringify({ id: crypto.randomUUID(), type: 'request', channel, args: [input] }))
    })
  }
  test('list only personal space and current project memberships; administrators gain no private access', async () => {
    const ws = await connect(alice, bob.account.id)
    const spaces = (await invoke(ws, R.LIST_SPACES, {})).result
    expect(spaces.map((space: any) => space.scope)).toEqual([{ kind: 'personal', ownerId: alice.account.id }, { kind: 'project', projectId: projectA }])
    const forbidden = await invoke(ws, R.GET_SESSION, { sessionId: privateId })
    expect(forbidden.error.code).toBe('BIO_ACCESS_DENIED'); expect(JSON.stringify(forbidden).includes('Synthetic private note')).toBe(false)
  })
  test('viewer cannot create or manage; editor creation is bound to the authenticated owner', async () => {
    const ws = await connect(bob)
    expect((await invoke(ws, R.CREATE_SESSION, { scope: { kind: 'project', projectId: projectA }, name: 'Denied' })).error.code).toBe('BIO_ACCESS_DENIED')
    expect((await invoke(ws, R.SET_MEMBER, { projectId: projectA, userId: bob.account.id, role: 'owner', active: true, expectedRevision: 2 })).error.code).toBe('BIO_ACCESS_DENIED')
    repo.setMember(alice.actor, projectA, bob.account.id, 'editor', true, 2)
    const created = (await invoke(ws, R.CREATE_SESSION, { scope: { kind: 'project', projectId: projectA }, name: 'Study' })).result
    expect(created.ownerId).toBe(bob.account.id); expect(created.scope).toEqual({ kind: 'project', projectId: projectA })
    expect((await invoke(ws, R.CREATE_SESSION, { scope: { kind: 'personal', ownerId: charlie.account.id }, name: 'Forged' })).error.code).toBe('BIO_ACCESS_DENIED')
  })
  test('current project lists and session reads fail immediately after revocation, even on an existing socket', async () => {
    const ws = await connect(bob)
    repo.put(alice.actor, 'session', { id: 'shared-session', ownerId: alice.account.id, scope: { kind: 'project', projectId: projectA }, policy: 'public', name: 'Shared', revision: 1, createdAt: 1 })
    expect((await invoke(ws, R.GET_SESSION, { sessionId: 'shared-session' })).result.name).toBe('Shared')
    repo.setMember(alice.actor, projectA, bob.account.id, 'viewer', false, 2)
    expect((await invoke(ws, R.GET_SESSION, { sessionId: 'shared-session' })).error.code).toBe('BIO_ACCESS_DENIED')
    expect((await invoke(ws, R.LIST_SPACES, {})).result.length).toBe(1)
    expect((await invoke(ws, R.LIST_SESSIONS, { scope: { kind: 'project', projectId: projectB } })).error.code).toBe('BIO_ACCESS_DENIED')
  })
  test('legacy raw files, shares, settings and transfers are disabled regardless of role or guessed workspace', async () => {
    const ws = await connect(alice, projectB)
    for (const channel of getAllChannelValues().filter(channel => !channel.startsWith('research:'))) {
      const result = await invoke(ws, channel, { workspaceId: projectB, path: 'Synthetic private path', userId: charlie.account.id })
      expect(result.result).toBeUndefined(); expect(result.error).toBeDefined()
    }
  })
  test('manifest covers every channel and accidental legacy registration is refused', () => {
    expect(profile.gate.manifest().map(row => row.channel)).toEqual(getAllChannelValues())
    expect(profile.gate.manifest().filter(row => row.status === 'enabled').length).toBe(9)
    expect(() => instance.server.handle('files:readFile', () => 'synthetic private file')).toThrow()
  })
  test('same-scope session pages preserve a stable cursor and reject actor/policy fields', async () => {
    const scope = { kind: 'project', projectId: projectA } as const
    for (const id of ['page-a', 'page-b', 'page-c']) repo.put(alice.actor, 'session', { id, scope, ownerId: alice.account.id,
      policy: 'public', name: id, revision: 1, createdAt: 1 })
    const ws = await connect(bob)
    const first = (await invoke(ws, R.LIST_SESSIONS, { scope, pageSize: 2 })).result
    expect(first.items.map((item: any) => item.id)).toEqual(['page-a', 'page-b'])
    const next = (await invoke(ws, R.LIST_SESSIONS, { scope, pageSize: 2, cursor: first.nextCursor })).result
    expect(next.items.map((item: any) => item.id)).toEqual(['page-c'])
    expect((await invoke(ws, R.CREATE_SESSION, { scope, name: 'Fake', ownerId: alice.account.id, policy: 'public' })).error.code).toBe('BIO_INPUT_INVALID')
  })
  test('write-role loss during an awaited feature response prevents its result', async () => {
    repo.setMember(alice.actor, projectA, bob.account.id, 'editor', true, 2)
    repo.put(bob.actor, 'session', { id: 'owned-study', ownerId: bob.account.id, scope: { kind: 'project', projectId: projectA },
      policy: 'public', name: 'Study', revision: 1, createdAt: 1 })
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), wait = new Promise<void>(resolve => { release = resolve })
    profile.registerFeature(R.SEARCH, async () => { entered(); await wait; return { items: [], privateMarker: 'synthetic delayed output' } })
    const ws = await connect(bob), response = invoke(ws, R.SEARCH, { sessionId: 'owned-study', query: 'public query' })
    await ready; repo.setMember(alice.actor, projectA, bob.account.id, 'viewer', true, 3); release()
    const frame = await response
    expect(frame.result).toBeUndefined(); expect(frame.error.code).toBe('BIO_ACCESS_DENIED')
    expect(JSON.stringify(frame).includes('synthetic delayed output')).toBe(false)
  })
  test('event body and unknown legacy events are refused before serialization', async () => {
    const frames: any[] = []; await connect(alice, undefined, { frames })
    instance.server.push('session:event', { to: 'all' }, { body: 'synthetic private text' })
    instance.server.push(R.EVENT, { to: 'all' }, { version: 1, id: 'event-a', sequence: 1,
      scope: { kind: 'personal', ownerId: alice.account.id }, sessionId: privateId, resourceId: privateId,
      revision: 1, kind: 'session-changed', body: 'synthetic private text' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(frames.some(frame => frame.type === 'event')).toBe(false)
  })
  test('revoked project events are purged before reconnect and cannot replay through edited metadata references', async () => {
    repo.put(alice.actor, 'session', { id: 'shared-session', ownerId: alice.account.id, scope: { kind: 'project', projectId: projectA }, policy: 'public', name: 'Shared', revision: 1, createdAt: 1 })
    const frames: any[] = [], ws = await connect(bob, undefined, { frames })
    const clientId = frames[0]?.clientId
    const closed = new Promise(resolve => ws.once('close', resolve)); ws.close(); await closed
    const event = { version: 1 as const, id: 'event-a', sequence: 1, scope: { kind: 'project' as const, projectId: projectA },
      sessionId: 'shared-session', resourceId: 'shared-session', revision: 1, kind: 'session-changed' as const }
    instance.server.push(R.EVENT, { to: 'all' }, event)
    // Mutating the publisher's object cannot change the authorization metadata
    // captured from the immutable serialized event in the server buffer.
    event.scope.projectId = projectB
    const owner = await connect(alice)
    expect((await invoke(owner, R.SET_MEMBER, { projectId: projectA, userId: bob.account.id, role: 'viewer', active: false, expectedRevision: 2 })).result.revision).toBe(3)
    const replay: any[] = []; await connect(bob, undefined, { reconnectClientId: clientId, frames: replay })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(replay.some(frame => frame.type === 'event')).toBe(false)
    expect(replay[0]?.stale).toBe(true)
  })
  test('legacy capabilities cannot be invoked on any user client even if advertised', async () => {
    const frames: any[] = []; await connect(bob, undefined, { frames, capabilities: ['client:secretFile'] })
    let code = ''; try { await instance.server.invokeClient(frames[0].clientId, 'client:secretFile', 'synthetic payload') }
    catch (error) { code = (error as { code?: string }).code ?? '' }
    expect(code).toBe('BIO_ACCESS_DENIED')
    expect(frames.some(frame => frame.type === 'request')).toBe(false)
  })
  test('response gate refuses another authorized project list or a mismatched created-session owner', () => {
    repo.setMember(charlie.actor, projectB, bob.account.id, 'viewer', true, 1)
    const other = repo.put(charlie.actor, 'session', { id: 'other-project-session', ownerId: charlie.account.id,
      scope: { kind: 'project', projectId: projectB }, policy: 'public', name: 'Other', revision: 1, createdAt: 1 })
    expect(() => profile.gate.authorizeResponse(bob.actor, R.LIST_SESSIONS,
      [{ scope: { kind: 'project', projectId: projectA } }], { items: [other] })).toThrow('Research access denied.')
    const privateSession = repo.get(bob.actor, 'session', privateId)
    expect(() => profile.gate.authorizeResponse(alice.actor, R.CREATE_SESSION,
      [{ scope: { kind: 'personal', ownerId: alice.account.id }, name: 'Mine' }], privateSession)).toThrow('Research access denied.')
  })
  test('resource-gate denied reads are scoped to the owner audit, not global account audit', async () => {
    const ws = await connect(alice)
    expect((await invoke(ws, R.GET_SESSION, { sessionId: privateId })).error.code).toBe('BIO_ACCESS_DENIED')
    expect(repo.readAudit(bob.actor, { kind: 'personal', ownerId: bob.account.id }).some(row => row.resourceId === privateId && row.outcome === 'denied')).toBe(true)
    const db = (repo as unknown as { db: import('bun:sqlite').Database }).db
    const statement = db.prepare<{ resource_id: string | null }, []>('SELECT resource_id FROM audit WHERE scope_key IS NULL')
    try { expect(statement.all().some(row => row.resource_id === privateId)).toBe(false) } finally { statement.finalize() }
  })
  test('mixed-scope buffered sequence gaps from proactive revocation force stale refresh', async () => {
    repo.put(alice.actor, 'session', { id: 'shared-session', ownerId: alice.account.id, scope: { kind: 'project', projectId: projectA }, policy: 'public', name: 'Shared', revision: 1, createdAt: 1 })
    const frames: any[] = [], ws = await connect(bob, undefined, { frames })
    const clientId = frames[0]?.clientId
    const closed = new Promise(resolve => ws.once('close', resolve)); ws.close(); await closed
    instance.server.push(R.EVENT, { to: 'all' }, { version: 1, id: 'personal-event', sequence: 1,
      scope: { kind: 'personal', ownerId: bob.account.id }, sessionId: privateId, resourceId: privateId, revision: 1, kind: 'session-changed' })
    instance.server.push(R.EVENT, { to: 'all' }, { version: 1, id: 'project-event', sequence: 2,
      scope: { kind: 'project', projectId: projectA }, sessionId: 'shared-session', resourceId: 'shared-session', revision: 1, kind: 'session-changed' })
    const owner = await connect(alice)
    await invoke(owner, R.SET_MEMBER, { projectId: projectA, userId: bob.account.id, role: 'viewer', active: false, expectedRevision: 2 })
    const replay: any[] = []; await connect(bob, undefined, { reconnectClientId: clientId, frames: replay })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(replay[0]?.stale).toBe(true)
    expect(replay.some(frame => frame.type === 'event' && frame.args?.[0]?.id === 'project-event')).toBe(false)
  })
  test('project audit is owner-only and includes actor/time without body or global identities', async () => {
    const owner = await connect(alice), viewer = await connect(bob)
    const scope = { kind: 'project', projectId: projectA }
    expect((await invoke(viewer, R.READ_AUDIT, { scope })).error.code).toBe('BIO_ACCESS_DENIED')
    const first = (await invoke(owner, R.READ_AUDIT, { scope, pageSize: 2 })).result
    expect(first.length).toBe(2); expect(typeof first[0].actorId).toBe('string'); expect(first[0].createdAt > 0).toBe(true)
    expect(Object.keys(first[0]).sort()).toEqual(['action', 'actorId', 'createdAt', 'outcome', 'resourceId', 'sequence'])
    const next = (await invoke(owner, R.READ_AUDIT, { scope, pageSize: 2, afterSequence: first.at(-1).sequence })).result
    expect(next.every((row: any) => row.sequence > first.at(-1).sequence)).toBe(true)
    expect((await invoke(owner, R.READ_AUDIT, { scope: { kind: 'personal', ownerId: bob.account.id } })).error.code).toBe('BIO_ACCESS_DENIED')
    const foreign = repo.readAudit(bob.actor, { kind: 'personal', ownerId: bob.account.id })
    expect(() => profile.gate.authorizeResponse(alice.actor, R.READ_AUDIT, [{ scope }], foreign)).toThrow('Research access denied.')
  })
  test('project creation, invitation and member lists use current management rights and authoritative roster', async () => {
    const owner = await connect(alice)
    const created = (await invoke(owner, R.CREATE_PROJECT, { name: 'New study' })).result
    expect(created.name).toBe('New study'); expect(created.revision).toBe(1)
    expect((await invoke(owner, R.INVITE_MEMBER, { projectId: created.id, username: 'bob', role: 'editor', expectedRevision: 1 })).result.revision).toBe(2)
    const members = (await invoke(owner, R.LIST_MEMBERS, { projectId: created.id })).result
    expect(members.some((member: any) => member.userId === bob.account.id && member.role === 'editor')).toBe(true)
    const otherRoster = repo.listMembers(alice.actor, projectA)
    expect(() => profile.gate.authorizeResponse(alice.actor, R.LIST_MEMBERS, [{ projectId: created.id }], otherRoster)).toThrow('Research access denied.')
  })
})
