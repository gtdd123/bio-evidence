import { z } from 'zod'
import { IdSchema } from '@bio-evidence/research-core'
const Account = z.strictObject({ id: IdSchema, username: z.string().min(3).max(64), administrator: z.boolean() })
const Login = z.strictObject({ account: Account, expiresAt: z.number().int().positive() })
const BrowserLogin = Login.extend({ sessionBinding: IdSchema })
const DesktopLogin = Login.extend({ token: z.string().regex(/^bio1\.[A-Za-z0-9_-]{43}$/) })
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export class BioAuthClientError extends Error {
  constructor(readonly status: number) { super(status === 401 ? 'Authentication failed.' : 'Account request failed.'); this.name = 'BioAuthClientError' }
}
export function validatedAuthOrigin(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.hash || url.search || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new BioAuthClientError(400)
  return url.origin
}
export function createBrowserAuthClient(origin: string, fetcher: Fetcher = fetch) {
  const base = validatedAuthOrigin(origin)
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetcher(base + path, { ...init, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new BioAuthClientError(response.status)
    return response.json()
  }
  return {
    login: async (username: string, password: string) => BrowserLogin.parse(await call('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    })),
    current: async (binding?: string) => z.strictObject({ account: Account, sessionBinding: IdSchema }).parse(await call('/api/auth/session', { headers: binding ? { 'X-Bio-Session-Binding': binding } : {} })),
    logout: async (binding?: string) => { await call('/api/auth/logout', { method: 'POST', headers: binding ? { 'X-Bio-Session-Binding': binding } : {} }) },
  }
}
/** For the Electron main process; never persist its token in browser storage. */
export async function loginDesktopAccount(origin: string, username: string, password: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(validatedAuthOrigin(origin) + '/api/auth/token', { method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
  if (!response.ok) throw new BioAuthClientError(response.status)
  return DesktopLogin.parse(await response.json())
}
