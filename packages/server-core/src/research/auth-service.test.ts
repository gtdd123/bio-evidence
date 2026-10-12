import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SqliteResearchRepository } from './sqlite-repository'
import { BioAuthService } from './auth-service'
import type { Database } from 'bun:sqlite'

const password = 'Synthetic-passphrase-9!'
describe('BioEvidence account authority', () => {
  let repository: SqliteResearchRepository, auth: BioAuthService, now: number
  beforeEach(async () => { repository = new SqliteResearchRepository(); now = 1000; auth = await BioAuthService.create(repository, () => now) })
  afterEach(() => repository.close())
  async function initialize() {
    const account = await auth.createAccount(null, 'admin', password, true)
    const login = await auth.login('admin', password)
    return { account, login }
  }
  test('first admin is created once; password is Argon2id and never part of public account', async () => {
    const { account } = await initialize()
    expect(repository.getUserForAuth('admin')?.passwordHash.startsWith('$argon2id$')).toBe(true)
    expect(Object.keys(account).sort()).toEqual(['administrator', 'id', 'username'])
    let rejected = false; try { await auth.createAccount(null, 'second', password, true) } catch { rejected = true }; expect(rejected).toBe(true)
  })
  test('wrong, absent and disabled accounts fail with the same safe error', async () => {
    const { login } = await initialize(); const user = await auth.createAccount(login.actor, 'student', password)
    auth.setActive(login.actor, user.id, false, 1)
    const errors: string[] = []
    for (const [name, input] of [['admin', 'incorrect-passphrase'], ['absent', password], ['student', password]]) {
      try { await auth.login(name!, input!) } catch (error) { errors.push((error as Error).message) }
    }
    expect(errors).toEqual(['Authentication failed.', 'Authentication failed.', 'Authentication failed.'])
  })
  test('random user sessions expire absolutely after 24 hours and reject the legacy server token', async () => {
    const { login } = await initialize()
    expect(login.expiresAt).toBe(now + 86_400_000)
    expect(auth.authenticate(login.token)?.userId).toBe(login.account.id)
    expect(auth.authenticate('old-craft-server-token')).toBeNull()
    now = login.expiresAt
    expect(auth.authenticate(login.token)).toBeNull(); expect(auth.resolveActor(login.actor.authSessionId)).toBeNull()
  })
  test('logout revokes one session; account disable revokes all existing sessions', async () => {
    const { login } = await initialize(); const student = await auth.createAccount(login.actor, 'student', password)
    const one = await auth.login('student', password), two = await auth.login('student', password)
    auth.logout(one.actor)
    expect(auth.authenticate(one.token)).toBeNull(); expect(auth.authenticate(two.token)?.userId).toBe(student.id)
    auth.setActive(login.actor, student.id, false, 1)
    expect(auth.authenticate(two.token)).toBeNull(); expect(auth.resolveActor(two.actor.authSessionId)).toBeNull()
    auth.setActive(login.actor, student.id, true, 2)
    expect(auth.authenticate(two.token)).toBeNull()
  })
  test('client administrator flag cannot grant account management; stale revision is rejected', async () => {
    const { login } = await initialize(); const student = await auth.createAccount(login.actor, 'student', password)
    const user = await auth.login('student', password)
    let rejected = false; try { await auth.createAccount({ ...user.actor, administrator: true }, 'forged', password, true) } catch { rejected = true }
    expect(rejected).toBe(true)
    expect(() => auth.setActive(user.actor, login.account.id, false, 1)).toThrow()
    auth.setActive(login.actor, student.id, false, 1)
    expect(() => auth.setActive(login.actor, student.id, true, 1)).toThrow()
    expect(() => auth.setActive(login.actor, login.account.id, false, 1)).toThrow()
  })
  test('account creation denial, repeated bootstrap and login CAS failure are audited without credentials', async () => {
    const { login } = await initialize(); const student = await auth.createAccount(login.actor, 'student', password)
    const user = await auth.login('student', password)
    try { await auth.createAccount(user.actor, 'forbidden', password) } catch {}
    try { await auth.createAccount(null, 'bootstrap-again', password, true) } catch {}
    expect(() => repository.issueAuthSession({ id: 'cas-session', userId: student.id, tokenHash: 'a'.repeat(64), expiresAt: 100000 }, 999)).toThrow()
    const db = (repository as unknown as { db: Database }).db
    const query = db.prepare<{ action: string; outcome: string }, []>('SELECT action,outcome FROM audit')
    try {
      const rows = query.all()
      for (const action of ['account-create', 'account-bootstrap', 'login']) expect(rows.some(row => row.action === action && row.outcome === 'denied')).toBe(true)
      expect(JSON.stringify(rows).includes(password)).toBe(false)
    } finally { query.finalize() }
  })
})
