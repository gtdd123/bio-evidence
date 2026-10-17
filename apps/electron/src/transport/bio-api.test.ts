import { expect, test } from 'bun:test'
import { buildClientApi } from './build-api'
import { CHANNEL_MAP } from './channel-map'

test('Web and desktop proxies expose typed research methods and scoped events on the existing transport', async () => {
  const calls: unknown[] = []
  const transport = { invoke: async (channel: string, ...args: unknown[]) => { calls.push([channel, ...args]); return [] }, on: (channel: string, callback: (...args: any[]) => void) => { calls.push(channel); callback({ kind: 'session-changed' }); return () => { calls.push('unsubscribed') } } }
  const api = buildClientApi(transport as any, CHANNEL_MAP) as any
  expect(typeof api.research?.listSpaces).toBe('function')
  await api.research.listSpaces({})
  await api.research.listSourceSnapshots({ sourceId: 'source', pageSize: 20 })
  const unsubscribe = api.research.onEvent((event: any) => expect(event.kind).toBe('session-changed')); unsubscribe()
  expect(calls).toEqual([['research:v1:listSpaces', {}], ['research:v1:listSourceSnapshots', { sourceId: 'source', pageSize: 20 }], 'research:v1:event', 'unsubscribed'])
})
