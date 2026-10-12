import { describe, expect, test } from 'bun:test'
import { createBrowserAuthClient, loginDesktopAccount, validatedAuthOrigin } from '../bio-client'
describe('pure shared BioEvidence auth clients', () => {
  test('browser uses cookie credentials, strict DTO and refuses credential redirects', async () => {
    let options: RequestInit | undefined
    const client = createBrowserAuthClient('https://lab.example', async (_url, init) => {
      options = init; return Response.json({ account: { id: 'account-a', username: 'student', administrator: false }, expiresAt: 1000 })
    })
    const result = await client.login('student', 'synthetic-password')
    expect(result.account.id).toBe('account-a'); expect(options?.credentials).toBe('same-origin'); expect(options?.mode).toBe('same-origin')
    expect(options?.redirect).toBe('error')
    expect(JSON.parse(options!.body as string)).toEqual({ username: 'student', password: 'synthetic-password' })
  })
  test('desktop never follows login redirects or sends a legacy server credential', async () => {
    let options: RequestInit | undefined
    await loginDesktopAccount('http://127.0.0.1:9100', 'student', 'synthetic-password', async (_url, init) => {
      options = init; return Response.json({ account: { id: 'account-a', username: 'student', administrator: false }, expiresAt: 1000, token: 'bio1.' + 'x'.repeat(43) })
    })
    expect(options?.redirect).toBe('error'); expect(new Headers(options?.headers).has('authorization')).toBe(false)
    expect(() => validatedAuthOrigin('http://lab.example')).toThrow()
    expect(() => validatedAuthOrigin('https://user:pass@lab.example')).toThrow()
  })
})
