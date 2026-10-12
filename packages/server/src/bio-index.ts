#!/usr/bin/env bun
import '../../../scripts/bio-runtime-guard.mjs'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { z } from 'zod'
import { resolveConfigDir, validateNamespacePath } from '@craft-agent/shared/config/namespace'
import { SqliteResearchRepository } from '../../server-core/src/research/sqlite-repository'
import { createBioAuthorityServer } from '../../server-core/src/research/authority-server'
const Settings = z.strictObject({ host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(9100),
  publicOrigin: z.string().url().optional(), trustedProxies: z.array(z.string()).max(32).optional(),
  tls: z.strictObject({ certPath: z.string().min(1), keyPath: z.string().min(1) }).optional(),
})
function readOwnedFile(path: string): string {
  const target = validateNamespacePath(resolve(resolveConfigDir(), path))
  const offset = relative(realpathSync.native(resolveConfigDir()), realpathSync.native(target))
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Invalid service file boundary')
  return readFileSync(target, 'utf8')
}
export async function startBioServer() {
  const settingsFile = join(resolveConfigDir(), 'service.json')
  const settings = Settings.parse(existsSync(settingsFile) ? JSON.parse(readOwnedFile(settingsFile)) : {})
  const repository = new SqliteResearchRepository(join(resolveConfigDir(), 'research.sqlite'))
  try {
    const instance = await createBioAuthorityServer(repository, { ...settings, tls: settings.tls ? {
      cert: readOwnedFile(settings.tls.certPath), key: readOwnedFile(settings.tls.keyPath),
    } : undefined })
    await instance.server.listen()
    let stopped = false
    const stop = () => { if (!stopped) { stopped = true; instance.server.close(); repository.close() } }
    return { ...instance, stop }
  } catch (error) { repository.close(); throw error }
}
if (import.meta.main) {
  try {
    const instance = await startBioServer()
    console.log(`BioEvidence account service: ${instance.boundary.publicOrigin}`)
    process.once('SIGINT', () => { instance.stop(); process.exit(0) })
    process.once('SIGTERM', () => { instance.stop(); process.exit(0) })
  } catch { console.error('BioEvidence service could not start. Check service settings, TLS and the owned data directory.'); process.exitCode = 1 }
}
