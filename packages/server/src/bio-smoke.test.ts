import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { RESEARCH_CHANNELS } from '@bio-evidence/research-core'
import { loginDesktopAccount } from '@craft-agent/shared/auth/bio-client'
import { BioAuthService } from '../../server-core/src/research/auth-service'
import { SqliteResearchRepository } from '../../server-core/src/research/sqlite-repository'
import { startOwnedService, exitWithin } from './__fixtures__/owned-service'

const password = 'Synthetic-entry-passphrase-123!'
function handshake(origin: string, token: string): Promise<{ type: string; registeredChannels?: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(origin.replace('http:', 'ws:'))
    const timer = setTimeout(() => { socket.terminate(); reject(Error('Handshake timeout')) }, 2000)
    const finish = () => { clearTimeout(timer); socket.close() }
    socket.once('open', () => socket.send(JSON.stringify({ id: 'smoke', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token })))
    socket.once('message', data => { resolve(JSON.parse(data.toString())); finish() })
    socket.once('error', error => { finish(); reject(error) })
    socket.once('close', () => { clearTimeout(timer); reject(Error('Handshake rejected')) })
  })
}
test('the real Bio entry accepts a persisted account bearer and rejects short, wrong and legacy shared tokens', async () => {
  const value = await startOwnedService('account-smoke', async root => {
    const repository = new SqliteResearchRepository(join(root, 'research.sqlite'))
    try { const auth = await BioAuthService.create(repository); await auth.createAccount(null, 'admin', password, true) }
    finally { repository.close() }
  })
  const heartbeat = setInterval(() => { (value.proc.stdin as Bun.FileSink).write('{"type":"heartbeat"}\n') }, 500)
  try {
    const login = await loginDesktopAccount(value.origin, 'admin', password)
    const accepted = await handshake(value.origin, login.token)
    expect(accepted.type).toBe('handshake_ack')
    expect(accepted.registeredChannels).toContain(RESEARCH_CHANNELS.LIST_SPACES)
    expect(accepted.registeredChannels).not.toContain('sessions:getAll')
    for (const token of ['short', 'bio1.' + 'x'.repeat(43), crypto.randomUUID() + crypto.randomUUID()]) {
      const rejected = await handshake(value.origin, token).catch(() => ({ type: 'closed' }))
      expect(rejected.type).not.toBe('handshake_ack')
    }
    const current = await fetch(value.origin + '/api/auth/session', { headers: { Authorization: `Bearer ${login.token}` } })
    expect(current.status).toBe(200)
    ;(value.proc.stdin as Bun.FileSink).write('{"type":"shutdown"}\n')
    expect(await exitWithin(value.proc)).toBe(0)
    expect(await value.output).toContain('BIOEVIDENCE_STOPPED=0')
  } finally { clearInterval(heartbeat); if (value.proc.exitCode === null) value.proc.kill(); await value.proc.exited; await value.errors }
}, 20000)

test('a fresh real service has no default account or public account bootstrap route', async () => {
  const value = await startOwnedService('no-account-smoke')
  try {
    const login = await fetch(value.origin + '/api/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) })
    expect(login.status).toBe(401)
    const bootstrap = await fetch(value.origin + '/api/auth/create', { method: 'POST', body: '{}' })
    expect(bootstrap.status).toBe(404)
    expect((await fetch(value.origin + '/api/auth/session')).status).toBe(401)
    ;(value.proc.stdin as Bun.FileSink).write('{"type":"shutdown"}\n')
    expect(await exitWithin(value.proc)).toBe(0)
  } finally { if (value.proc.exitCode === null) value.proc.kill(); await value.proc.exited; await value.errors }
}, 20000)

test('invalid service settings prevent the real listener from becoming ready', async () => {
  await expect(startOwnedService('invalid-config-smoke', async root => {
    writeFileSync(join(root, 'service.json'), JSON.stringify({ host: '0.0.0.0', port: 0, workerPath: 'untrusted' }))
  })).rejects.toThrow('Service exited before readiness')
}, 20000)
