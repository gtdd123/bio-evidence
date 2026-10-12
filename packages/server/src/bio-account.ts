#!/usr/bin/env bun
import '../../../scripts/bio-runtime-guard.mjs'
import { emitKeypressEvents } from 'node:readline'
import { join } from 'node:path'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
import { SqliteResearchRepository } from '../../server-core/src/research/sqlite-repository'
import { BioAuthService } from '../../server-core/src/research/auth-service'

/** Passwords stay off argv, environment, terminal echo, and logs. */
export async function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('A private interactive terminal is required')
  process.stdout.write(prompt); emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true); process.stdin.resume()
  return await new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      process.stdin.off('keypress', input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n')
      if (error) reject(error); else resolve(value)
    }
    const input = (text: string, key: { ctrl?: boolean; name?: string }) => {
      if (key.ctrl && key.name === 'c') { finish(Error('Account command cancelled')); return }
      if (key.name === 'return' || key.name === 'enter') { finish(); return }
      if (key.name === 'backspace') { value = value.slice(0, -1); return }
      if (text && !key.ctrl && !/[\r\n\x00-\x1f\x7f]/.test(text)) {
        value += text
        if (value.length > 1024) finish(Error('Password too long'))
      }
    }
    process.stdin.on('keypress', input)
  })
}

export async function accountCommand(args: string[], readSecret = hiddenPassword): Promise<void> {
  const command = args[0], allowed = new Set(['--username', '--admin-user', '--administrator'])
  const options = new Map<string, string>()
  if (!['init-admin', 'create', 'enable', 'disable'].includes(command ?? '')) throw Error('Use init-admin, create, enable or disable')
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!
    if (!allowed.has(key) || options.has(key)) throw Error('Invalid account option; passwords cannot be arguments')
    if (key === '--administrator') options.set(key, 'true')
    else {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw Error('Missing account option')
      options.set(key, value)
    }
  }
  const username = options.get('--username')
  if (!username) throw Error('--username is required')
  const repository = new SqliteResearchRepository(join(resolveConfigDir(), 'research.sqlite'))
  try {
    const auth = await BioAuthService.create(repository)
    if (command === 'init-admin') {
      if (options.has('--admin-user') || options.has('--administrator')) throw Error('Invalid bootstrap options')
      await auth.createAccount(null, username, await readSecret('New administrator password: '), true)
    } else {
      const administrator = options.get('--admin-user')
      if (!administrator) throw Error('--admin-user is required')
      const login = await auth.login(administrator, await readSecret('Administrator password: '))
      try {
        if (command === 'create') await auth.createAccount(login.actor, username, await readSecret('New account password: '), options.has('--administrator'))
        else {
          if (options.has('--administrator')) throw Error('Invalid account status options')
          const target = repository.getUserForAuth(username)
          if (!target) throw Error('Account does not exist')
          auth.setActive(login.actor, target.id, command === 'enable', target.revision)
        }
      } finally { if (auth.resolveActor(login.actor.authSessionId)) auth.logout(login.actor) }
    }
  } finally { repository.close() }
}
if (import.meta.main) {
  try { await accountCommand(process.argv.slice(2)); console.log('Account updated.') }
  catch { console.error('Account command failed. Check command options, authorization, or stop the running authority service first.'); process.exitCode = 1 }
}
