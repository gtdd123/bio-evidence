import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
import { SqliteResearchRepository } from '../../server-core/src/research/sqlite-repository'
import { BioAuthService } from '../../server-core/src/research/auth-service'
import { accountCommand } from './bio-account'
const password = 'Synthetic-passphrase-9!'
describe('owned local account management CLI', () => {
  test('initialize once, create with authenticated administrator, disable/enable; never accept password argv', async () => {
    await accountCommand(['init-admin', '--username', 'cli-admin'], async () => password)
    let rejected = false; try { await accountCommand(['init-admin', '--username', 'second-admin'], async () => password) } catch { rejected = true }; expect(rejected).toBe(true)
    await accountCommand(['create', '--username', 'cli-student', '--admin-user', 'cli-admin'], async () => password)
    await accountCommand(['disable', '--username', 'cli-student', '--admin-user', 'cli-admin'], async () => password)
    let repo = new SqliteResearchRepository(join(resolveConfigDir(), 'research.sqlite'))
    expect(repo.getUserForAuth('cli-student')?.active).toBe(false); repo.close()
    await accountCommand(['enable', '--username', 'cli-student', '--admin-user', 'cli-admin'], async () => password)
    repo = new SqliteResearchRepository(join(resolveConfigDir(), 'research.sqlite'))
    try {
      const auth = await BioAuthService.create(repo); const login = await auth.login('cli-student', password)
      expect(login.actor.administrator).toBe(false)
    } finally { repo.close() }
    rejected = false; try { await accountCommand(['create', '--username', 'leak', '--password', password], async () => password) } catch { rejected = true }; expect(rejected).toBe(true)
  })
})
