import { expect, test } from 'bun:test'
import { BioClientController, type BioAuthorizedSession } from './bio-client'
function session(id: string) {
  const account = { id, username: id, administrator: false }; let closed = 0, destroyed = 0
  let connection: (value: { status: string }) => void = () => {}
  let event: (value: unknown) => void = () => {}
  const value: BioAuthorizedSession = { account, current: async () => account, close: async () => { closed++ }, importPdf: async () => ({ status: 'unavailable' }),
    transport: { connect: () => connection({ status: 'connected' }), destroy: () => { destroyed++ }, invoke: async () => [],
      on: (_, cb) => { event = cb; return () => {} }, onConnectionStateChanged: cb => { connection = cb; return () => {} } } }
  return { value, closed: () => closed, destroyed: () => destroyed, emit: (raw: unknown) => event(raw), disconnect: () => connection({ status: 'disconnected' }), reconnect: () => connection({ status: 'connected' }) }
}
test('account switching drops late RPC bodies and old events, and exposes no generic legacy RPC', async () => {
  const alice = session('alice'), bob = session('bob')
  const client = new BioClientController({ restore: async () => null, login: async (_, user) => user === 'alice' ? alice.value : bob.value }, 'http://127.0.0.1:9100')
  await client.login(client.state.origin, 'alice', 'synthetic')
  expect(client.state.account?.id).toBe('alice'); expect(client.state.status).toBe('connected')
  let release!: (value: unknown) => void
  alice.value.transport.invoke = () => new Promise(resolve => { release = resolve })
  const pending = client.invoke('research:v1:listSpaces', {}); let events = 0
  client.on('research:v1:event', () => events++)
  await client.login('http://localhost:9101', 'bob', 'synthetic')
  release([{ name: 'Alice private body' }]); await expect(pending).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' })
  alice.emit({ version: 1, id: 'event', sequence: 1, scope: { kind: 'personal', ownerId: 'alice' }, sessionId: 'session', resourceId: 'session', revision: 1, kind: 'session-changed' })
  expect(events).toBe(0); expect(alice.destroyed()).toBe(1); expect(alice.closed()).toBe(1)
  expect(client.state.origin).toBe('http://localhost:9101')
  await expect(client.invoke('sessions:getAll', {})).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' })
  bob.disconnect(); expect(client.state.status).toBe('disconnected')
  await expect(client.invoke('research:v1:listSpaces', {})).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' })
  await client.logout(); expect(client.state.account).toBeNull(); client.dispose()
})
test('logout during a slow login cannot bind its late identity or leave its token active', async () => {
  const alice = session('alice'); let release!: () => void
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  const ready = new Promise<void>(resolve => { release = resolve })
  const client = new BioClientController({ restore: async () => null, login: async () => { entered(); await ready; return alice.value } }, 'http://127.0.0.1:9100')
  const login = client.login(client.state.origin, 'alice', 'synthetic')
  await started; const logout = client.logout(); release()
  await Promise.all([login, logout]); expect(client.state.account).toBeNull(); expect(alice.closed()).toBe(1); expect(alice.destroyed()).toBe(1)
  client.dispose()
})
test('reconnection refreshes authority instead of accepting a body issued before disconnection', async () => {
  const alice = session('alice'), client = new BioClientController({ restore: async () => null, login: async () => alice.value }, 'http://127.0.0.1:9100')
  await client.login(client.state.origin, 'alice', 'synthetic')
  let release!: (value: unknown) => void
  alice.value.transport.invoke = () => new Promise(resolve => { release = resolve })
  const pending = client.invoke('research:v1:listSpaces', {}); alice.disconnect(); alice.reconnect(); release(['stale'])
  await expect(pending).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' }); client.dispose()
})
test('dispose permanently closes queued current and a restore already in progress', async () => {
  let restores = 0
  const empty = new BioClientController({ restore: async () => { restores++; return session('alice').value }, login: async () => session('alice').value }, 'http://127.0.0.1:9100')
  const queued = empty.current(); empty.dispose(); await queued
  expect(restores).toBe(0); expect(empty.state.account).toBeNull()
  const alice = session('alice'); let release!: () => void, entered!: () => void
  const wait = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  const active = new BioClientController({ restore: async () => { entered(); await wait; return alice.value }, login: async () => alice.value }, 'http://127.0.0.1:9100')
  const pending = active.current(); await ready; active.dispose(); release(); await pending
  expect(active.state.account).toBeNull(); expect(alice.destroyed()).toBe(1)
  await expect(active.login('http://127.0.0.1:9100', 'alice', 'synthetic')).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' })
})
test('a current resource denial invalidates visible resources and outstanding reads without adopting another account', async () => {
  const alice = session('alice'), client = new BioClientController({ restore: async () => null, login: async () => alice.value }, 'http://127.0.0.1:9100')
  await client.login(client.state.origin, 'alice', 'synthetic')
  let release!: (value: unknown) => void
  alice.value.transport.invoke = async channel => { if (channel.endsWith('getSession')) throw { code: 'BIO_ACCESS_DENIED' }; return new Promise(resolve => { release = resolve }) }
  const before = client.state.viewRevision ?? 0, old = client.invoke('research:v1:listSpaces', {})
  await expect(client.invoke('research:v1:getSession', { sessionId: 'session' })).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' })
  expect(client.state.viewRevision).toBe(before + 1); expect(client.state.account?.id).toBe('alice')
  expect(client.state.errorCode).toBe('BIO_ACCESS_DENIED')
  await client.current(); expect(client.state.errorCode).toBe('BIO_ACCESS_DENIED')
  release(['old body']); await expect(old).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' }); client.dispose()
})
