import { describe, expect, test } from 'bun:test'
import { WsRpcClient } from '../client'
describe('common authenticated WS connection URL boundary', () => {
  test('all constructors refuse remote plaintext, deceptive loopback names, userinfo and credential query before connect', () => {
    for (const url of ['ws://lab.example/rpc', 'ws://127.0.0.1.evil.example', 'ws://localhost.evil.example',
      'ws://[2001:db8::1]', 'wss://user:pass@lab.example', 'wss://lab.example?token=synthetic', 'ws://127.0.0.1/#fragment']) {
      expect(() => new WsRpcClient(url, { token: 'synthetic-user-token' })).toThrow()
    }
  })
  test('local loopback and verified WSS are accepted; certificate verification cannot be disabled', () => {
    for (const url of ['ws://127.0.0.1:9100', 'ws://localhost:9100', 'ws://[::1]:9100', 'wss://lab.example/rpc']) {
      const client = new WsRpcClient(url); client.destroy()
    }
    expect(() => new WsRpcClient('wss://lab.example', { tlsRejectUnauthorized: false })).toThrow()
  })
})
