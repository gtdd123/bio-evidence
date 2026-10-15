import { expect, test } from 'bun:test'
import WebSocket from 'ws'
import { RESEARCH_CHANNELS as R } from '@bio-evidence/research-core'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { SqliteResearchRepository } from './sqlite-repository'
import { ArtifactsService } from './artifacts-service'
import { createBioAuthorityServer } from './authority-server'
import { registerResearchRpcProfile } from './rpc-profile'
test('authenticated project editors revise and review; viewers read/export and revocation refuses every artifact path', async () => {
  const repo = new SqliteResearchRepository(), server = await createBioAuthorityServer(repo, { port: 0 }), sockets: WebSocket[] = []
  try {
    const password = 'Synthetic-artifacts-123!'
    await server.auth.createAccount(null, 'alice', password, true); const alice = await server.auth.login('alice', password)
    await server.auth.createAccount(alice.actor, 'bob', password); const bob = await server.auth.login('bob', password)
    repo.createProject(alice.actor, 'project', 'Project'); repo.setMember(alice.actor, 'project', bob.actor.userId, 'editor', true, 1)
    const scope = { kind: 'project', projectId: 'project' } as const
    repo.put(alice.actor, 'session', { id: 'session', scope, ownerId: alice.actor.userId, name: 'Research', policy: 'public', revision: 1, createdAt: 1 })
    repo.put(alice.actor, 'source', { id: 'source', scope, policy: 'public', provider: 'pdf-import', identifiers: {}, license: { status: 'unknown' }, createdAt: 1 })
    repo.put(alice.actor, 'snapshot', { id: 'snapshot', sourceId: 'source', scope, policy: 'public', license: { status: 'unknown' }, format: 'pdf', acquiredBy: 'declared-public-pdf', retrievedAt: 1, contentHash: 'a'.repeat(64),
      coverage: { level: 'full', totalUnits: 1, units: [{ unit: 1, status: 'read' }] }, blocks: [{ id: 'block', unit: 1, text: 'Synthetic evidence', locator: { kind: 'pdf-page', page: 1 } }] })
    registerResearchRpcProfile(server.server, repo, undefined, undefined, undefined, undefined, new ArtifactsService(repo)); await server.server.listen()
    const connect = async (login: typeof alice) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.server.port}`); sockets.push(ws)
      await new Promise<void>(resolve => { ws.once('open', () => ws.send(JSON.stringify({ id: 'auth', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: login.token }))); ws.once('message', () => resolve()) }); return ws
    }
    const ws = await connect(bob), invoke = (channel: string, input: unknown) => new Promise<any>(resolve => { ws.once('message', data => resolve(JSON.parse(data.toString()))); ws.send(JSON.stringify({ id: crypto.randomUUID(), type: 'request', channel, args: [input] })) })
    const created = await invoke(R.CREATE_EVIDENCE, { sessionId: 'session', claim: 'Claim', factSummary: 'Observed excerpt', limitations: 'Synthetic', citations: [{ snapshotId: 'snapshot', blockId: 'block', start: 0, end: 18, quote: 'Synthetic evidence' }] })
    expect(created.error).toBeUndefined(); expect(created.result.authorId).toBe(bob.actor.userId)
    const evidence = created.result
    expect(repo.get(alice.actor, 'session', 'session')).toMatchObject({ ownerId: alice.actor.userId, policy: 'restricted' })
    const report = (await invoke(R.CREATE_REPORT, { sessionId: 'session', title: 'Report', researchQuestion: 'Public question', materialScope: 'Synthetic PDF', limitations: 'Synthetic only', claims: [{ id: 'claim', text: 'Conclusion', evidenceRevisionIds: [evidence.id] }] })).result
    expect(report.structuralStatus).toBe('structure-valid')
    expect((await invoke(R.REVIEW_ARTIFACT, { kind: 'report', revisionId: report.id, expectedRevision: 1, decision: 'needs-changes' })).result.reviewStatus).toBe('needs-changes')
    expect((await invoke(R.REVIEW_ARTIFACT, { kind: 'report', revisionId: report.id, expectedRevision: 1, decision: 'confirmed' })).error.code).toBe('BIO_REVISION_CONFLICT')
    const page = (await invoke(R.LIST_ARTIFACTS, { sessionId: 'session', pageSize: 1 })).result
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeDefined()
    expect((await invoke(R.LIST_ARTIFACTS, { sessionId: 'session', pageSize: 1, cursor: page.nextCursor })).result.items).toHaveLength(1)
    const auditAfter = repo.readAudit(alice.actor, scope, 200).at(-1)?.sequence ?? 0
    repo.setMember(alice.actor, 'project', bob.actor.userId, 'viewer', true, 2)
    expect((await invoke(R.GET_EVIDENCE, { revisionId: evidence.id })).result.revision.id).toBe(evidence.id)
    expect((await invoke(R.EXPORT_REPORT, { revisionId: report.id })).result.content).toContain('Synthetic PDF')
    expect((await invoke(R.SAVE_EVIDENCE, { evidenceId: evidence.evidenceId, expectedRevision: 1, claim: 'Denied', citations: evidence.citations })).error.code).toBe('BIO_ACCESS_DENIED')
    repo.setMember(alice.actor, 'project', bob.actor.userId, 'viewer', false, 3)
    for (const channel of [R.GET_EVIDENCE, R.EXPORT_EVIDENCE, R.GET_REPORT, R.EXPORT_REPORT]) expect((await invoke(channel, { revisionId: channel === R.GET_EVIDENCE || channel === R.EXPORT_EVIDENCE ? evidence.id : report.id })).error.code).toBe('BIO_ACCESS_DENIED')
    const audit = repo.readAudit(alice.actor, scope, 200, auditAfter)
    expect(audit).toContainEqual(expect.objectContaining({ action: 'artifact-evidence-save-request', outcome: 'denied', resourceId: evidence.evidenceId }))
    expect(audit).toContainEqual(expect.objectContaining({ action: 'artifact-evidence-export-request', outcome: 'denied', resourceId: evidence.id }))
  } finally { for (const ws of sockets) ws.terminate(); server.server.close(); repo.close() }
})
