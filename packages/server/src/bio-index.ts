#!/usr/bin/env bun
import '../../../scripts/bio-runtime-guard.mjs'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { z } from 'zod'
import { resolveConfigDir, validateNamespacePath } from '@craft-agent/shared/config/namespace'
import { SqliteResearchRepository } from '../../server-core/src/research/sqlite-repository'
import { createBioAuthorityServer } from '../../server-core/src/research/authority-server'
import { registerResearchRpcProfile } from '../../server-core/src/research/rpc-profile'
import { MaterialsService } from '../../server-core/src/research/materials-service'
import { loadMaterialGrants } from '../../server-core/src/research/material-grants-config'
import { MaterialBudgetsSchema, ResearchError } from '@bio-evidence/research-core'
import { createMaterialsHttpAdapter } from '../../server-core/src/research/materials-http'
const Settings = z.strictObject({ host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(9100),
  publicOrigin: z.string().url().optional(), trustedProxies: z.array(z.string()).max(32).optional(),
  tls: z.strictObject({ certPath: z.string().min(1), keyPath: z.string().min(1) }).optional(),
  materialBudgets: MaterialBudgetsSchema.optional(),
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
    let materialHttp: ReturnType<typeof createMaterialsHttpAdapter> | undefined
    const instance = await createBioAuthorityServer(repository, { ...settings, additionalHttpHandler: (request, response) => materialHttp?.(request, response) ?? false, tls: settings.tls ? {
      cert: readOwnedFile(settings.tls.certPath), key: readOwnedFile(settings.tls.keyPath),
    } : undefined })
    const materials = new MaterialsService(repository, loadMaterialGrants(), { budgets: settings.materialBudgets, currentActor: actor => {
      const current = instance.auth.resolveActor(actor.authSessionId)
      if (!current || current.userId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED')
      return current
    } })
    const profile = registerResearchRpcProfile(instance.server, repository, materials)
    materialHttp = createMaterialsHttpAdapter(profile, instance.auth, instance.boundary)
    await instance.server.listen()
    let stopped = false
    const stop = () => { if (!stopped) { stopped = true; instance.server.close(); repository.close() } }
    return { ...instance, profile, stop }
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
