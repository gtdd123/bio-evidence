import { expect, test } from 'bun:test'
import WebSocket from 'ws'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { CredentialManager } from '@craft-agent/shared/credentials'
import { SqliteResearchRepository } from './sqlite-repository'
import { ResearchConnectionsService } from './model-connections'
import { createBioAuthorityServer } from './authority-server'
import { registerResearchRpcProfile } from './rpc-profile'

test('authenticated connection configuration uses real encrypted storage, redacted results and current project authorization', async () => {
  const repo = new SqliteResearchRepository(), authority = await createBioAuthorityServer(repo, { port: 0 }), manager = new CredentialManager(), sockets: WebSocket[] = []
  const connections = new ResearchConnectionsService(repo, manager, actor => {
    const fresh = authority.auth.resolveActor(actor.authSessionId)
    if (!fresh || fresh.userId !== actor.userId) throw Error('Synthetic revoked authentication')
    return fresh
  })
  let credentialId: string | undefined
  try {
    const password = 'Synthetic-connections-123!'
    await authority.auth.createAccount(null, 'alice', password, true); const alice = await authority.auth.login('alice', password)
    await authority.auth.createAccount(alice.actor, 'bob', password); const bob = await authority.auth.login('bob', password)
    await authority.auth.createAccount(alice.actor, 'charlie', password); const charlie = await authority.auth.login('charlie', password)
    repo.createProject(alice.actor, 'project', 'Project'); repo.setMember(alice.actor, 'project', bob.actor.userId, 'viewer', true, 1)
    const scope = { kind: 'project', projectId: 'project' } as const
    const profile = registerResearchRpcProfile(authority.server, repo, undefined, undefined, undefined, undefined, undefined, connections)
    await authority.server.listen()
    const connect = async (login: typeof alice) => {
      const ws = new WebSocket(`ws://127.0.0.1:${authority.server.port}`); sockets.push(ws)
      await new Promise<void>(resolve => { ws.once('open', () => ws.send(JSON.stringify({ id: 'auth', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: login.token }))); ws.once('message', () => resolve()) })
      return (channel: string, input: unknown) => new Promise<any>(resolve => { ws.once('message', data => resolve(JSON.parse(data.toString()))); ws.send(JSON.stringify({ id: crypto.randomUUID(), type: 'request', channel, args: [input] })) })
    }
    const asAdmin = await connect(alice), asMember = await connect(bob), asOutsider = await connect(charlie)
    const configuration = { slug: 'official', name: 'Official', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', enabled: true, scopes: [scope], models: [{ id: 'synthetic-gpt', contextWindow: 32000, maxOutputTokens: 4096 }] }
    const request = { configuration, expectedRevision: 0, apiKey: 'synthetic-rpc-key' }
    const saved = await asAdmin('research:v1:saveModelConnection', request)
    expect(saved.error).toBeUndefined(); expect(saved.result).toMatchObject({ slug: 'official', revision: 1, keyConfigured: true })
    expect(JSON.stringify(saved)).not.toContain('synthetic-rpc-key'); expect(JSON.stringify(saved)).not.toContain('credentialId')
    credentialId = repo.managedResearchConnection(alice.actor, 'official')!.credentialId
    const listed = await asMember('research:v1:listModelConnections', { scope })
    expect(listed.result).toEqual([saved.result])
    expect((await asOutsider('research:v1:listModelConnections', { scope })).error.code).toBe('BIO_ACCESS_DENIED')
    expect((await asMember('research:v1:saveModelConnection', request)).error.code).toBe('BIO_ACCESS_DENIED')
    expect(() => profile.gate.authorizeResponse(bob.actor, 'research:v1:listModelConnections', [{ scope }], [{ ...saved.result, apiKey: 'synthetic-leaked-key' }])).toThrow()
    const changed = await asAdmin('research:v1:saveModelConnection', { configuration: { ...configuration, name: 'Updated' }, expectedRevision: 1 })
    expect(changed.result).toMatchObject({ name: 'Updated', revision: 2 })
    expect(() => profile.gate.authorizeResponse(alice.actor, 'research:v1:saveModelConnection', [request], saved.result)).toThrow()
    expect(() => profile.gate.authorizeResponse(bob.actor, 'research:v1:listModelConnections', [{ scope }], listed.result)).toThrow()
    repo.setMember(alice.actor, 'project', bob.actor.userId, 'viewer', false, 2)
    expect(() => profile.gate.authorizeResponse(bob.actor, 'research:v1:listModelConnections', [{ scope }], [changed.result])).toThrow()
    expect((await asMember('research:v1:listModelConnections', { scope })).error.code).toBe('BIO_ACCESS_DENIED')
    expect(repo.readAudit(bob.actor, { kind: 'personal', ownerId: bob.actor.userId }, 200)).toContainEqual(expect.objectContaining({ action: 'connection-save', outcome: 'denied' }))
  } finally {
    for (const ws of sockets) ws.terminate()
    authority.server.close()
    if (credentialId) await manager.deleteLlmApiKey(credentialId)
    repo.close()
  }
}, 20000)
