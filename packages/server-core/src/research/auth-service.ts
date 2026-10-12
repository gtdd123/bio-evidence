import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { parseContract, type Actor, type ResearchRepository, type PublicAccount } from '@bio-evidence/research-core'
export type { PublicAccount } from '@bio-evidence/research-core'
import { CodedError } from '@craft-agent/shared/protocol'
const Username = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/)
const Password = z.string().min(12).max(1024)
const SESSION_MS = 86_400_000
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const failed = () => new CodedError('AUTH_FAILED', 'Authentication failed.')
export class BioAuthService {
  static async create(repository: ResearchRepository, now = Date.now): Promise<BioAuthService> {
    const dummyHash = await Bun.password.hash(randomBytes(32).toString('base64url'), { algorithm: 'argon2id' })
    return new BioAuthService(repository, now, dummyHash)
  }
  private constructor(private readonly repository: ResearchRepository, private readonly now: () => number, private readonly dummyHash: string) {}
  private trusted(actor: Actor): Actor {
    const current = this.resolveActor(actor.authSessionId)
    if (!current || current.userId !== actor.userId) throw failed()
    return current
  }
  async createAccount(actor: Actor | null, username: string, password: string, administrator = false): Promise<PublicAccount> {
    const name = parseContract(Username, username)
    parseContract(Password, password); parseContract(z.boolean(), administrator)
    if (actor) {
      let current: Actor
      try { current = this.trusted(actor) } catch { this.repository.recordAuthFailure('account-create'); throw failed() }
      if (!current.administrator) { this.repository.recordAuthFailure('account-create', current.userId); throw failed() }
    }
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })
    const user = { id: randomUUID(), username: name, passwordHash, active: true, administrator, revision: 1 }
    let current: Actor | null = null
    if (actor) {
      try { current = this.trusted(actor) } catch { this.repository.recordAuthFailure('account-create'); throw failed() }
    }
    this.repository.createAuthorityAccount(current, user)
    return { id: user.id, username: user.username, administrator: user.administrator }
  }
  async login(username: string, password: string): Promise<{ token: string; actor: Actor; account: PublicAccount; expiresAt: number }> {
    if (!Username.safeParse(username).success || typeof password !== 'string' || password.length > 1024) { this.repository.recordAuthFailure(); throw failed() }
    const user = this.repository.getUserForAuth(username)
    const valid = await Bun.password.verify(password, user?.passwordHash ?? this.dummyHash).catch(() => false)
    if (!valid || !user?.active) { this.repository.recordAuthFailure(); throw failed() }
    const token = `bio1.${randomBytes(32).toString('base64url')}`, id = randomUUID(), expiresAt = this.now() + SESSION_MS
    try { this.repository.issueAuthSession({ id, userId: user.id, tokenHash: tokenHash(token), expiresAt }, user.revision) } catch { throw failed() }
    const actor = this.resolveActor(id)
    if (!actor) throw failed()
    return { token, actor, account: { id: user.id, username: user.username, administrator: actor.administrator }, expiresAt }
  }
  authenticate(token: string): Actor | null {
    if (typeof token !== 'string' || !/^bio1\.[A-Za-z0-9_-]{43}$/.test(token)) return null
    return this.repository.findAuthenticatedActor(tokenHash(token), this.now())
  }
  resolveActor(sessionId: string): Actor | null { return this.repository.resolveAuthenticatedActor(sessionId, this.now()) }
  currentAccount(actor: Actor): PublicAccount { return this.repository.currentAccount(this.trusted(actor)) }
  logout(actor: Actor): void { this.repository.revokeAuthSession(this.trusted(actor)) }
  setActive(actor: Actor, userId: string, active: boolean, expectedRevision: number): void {
    let current: Actor
    try { current = this.trusted(actor) } catch { this.repository.recordAuthFailure('account-status'); throw failed() }
    this.repository.setAccountActive(current, userId, active, expectedRevision)
  }
}
