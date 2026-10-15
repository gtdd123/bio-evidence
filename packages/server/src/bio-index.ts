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
import { MaterialBudgetsSchema, MaterialImageBudgetsSchema, LiteratureBudgetsSchema, DocumentBudgetsSchema, ResearchError } from '@bio-evidence/research-core'
import { createMaterialsHttpAdapter } from '../../server-core/src/research/materials-http'
import { MaterialPreviewService } from '../../server-core/src/research/material-preview'
import { LiteratureService } from '../../server-core/src/research/literature-service'
import { EuropePmcProvider } from '../../server-core/src/research/literature-provider'
import { DocumentParseService } from '../../server-core/src/research/document-parse'
import { SourceSnapshotService } from '../../server-core/src/research/source-snapshots'
import { createDocumentsHttpAdapter } from '../../server-core/src/research/documents-http'
import { ArtifactsService } from '../../server-core/src/research/artifacts-service'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { ResearchConnectionsService } from '../../server-core/src/research/model-connections'
import { PublicInputService } from '../../server-core/src/research/public-input'
import { PublicModelWorkerService } from '../../server-core/src/research/public-model-worker'
import { PublicModelExecutor } from '../../server-core/src/research/public-model-executor'
import type { Actor } from '@bio-evidence/research-core'
const Settings = z.strictObject({ host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(9100),
  publicOrigin: z.string().url().optional(), trustedProxies: z.array(z.string()).max(32).optional(),
  tls: z.strictObject({ certPath: z.string().min(1), keyPath: z.string().min(1) }).optional(),
  materialBudgets: MaterialBudgetsSchema.optional(),
  imageBudgets: MaterialImageBudgetsSchema.optional(),
  literatureBudgets: LiteratureBudgetsSchema.optional(),
  documentBudgets: DocumentBudgetsSchema.optional(),
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
    let documentHttp: ReturnType<typeof createDocumentsHttpAdapter> | undefined
    const instance = await createBioAuthorityServer(repository, { ...settings, additionalHttpHandler: (request, response) => documentHttp?.(request, response) || materialHttp?.(request, response) || false, tls: settings.tls ? {
      cert: readOwnedFile(settings.tls.certPath), key: readOwnedFile(settings.tls.keyPath),
    } : undefined })
    const materials = new MaterialsService(repository, loadMaterialGrants(), { budgets: settings.materialBudgets, currentActor: actor => {
      const current = instance.auth.resolveActor(actor.authSessionId)
      if (!current || current.userId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED')
      return current
    } })
    const previews = new MaterialPreviewService(materials, settings.imageBudgets)
    const literature = new LiteratureService(repository, new EuropePmcProvider(settings.literatureBudgets), { currentActor: actor => {
      const current = instance.auth.resolveActor(actor.authSessionId)
      if (!current || current.userId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED')
      return current
    } })
    const snapshots = new SourceSnapshotService(repository, literature, new DocumentParseService(settings.documentBudgets), { materials, currentActor: actor => {
      const current = instance.auth.resolveActor(actor.authSessionId)
      if (!current || current.userId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED')
      return current
    } })
    const currentActor = (actor: Actor) => {
      const current = instance.auth.resolveActor(actor.authSessionId)
      if (!current || current.userId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED')
      return current
    }
    const connections = new ResearchConnectionsService(repository, getCredentialManager(), currentActor)
    const publicInputs = new PublicInputService(repository, connections.broker, { currentActor })
    const modelWorker = new PublicModelWorkerService()
    const modelExecutor = new PublicModelExecutor(repository, publicInputs, connections.broker, modelWorker)
    const profile = registerResearchRpcProfile(instance.server, repository, materials, previews, literature, snapshots, new ArtifactsService(repository), connections)
    materialHttp = createMaterialsHttpAdapter(profile, instance.auth, instance.boundary, { materials, previews })
    documentHttp = createDocumentsHttpAdapter(snapshots, instance.auth, instance.boundary)
    await instance.server.listen()
    let stopPromise: Promise<void> | undefined
    const stop = () => stopPromise ??= (async () => { instance.server.close(); await modelWorker.close(); await documentHttp.close(); await snapshots.close(); await previews.close(); repository.close() })()
    return { ...instance, profile, stop, research: { connections, publicInputs, modelWorker, modelExecutor } }
  } catch (error) { repository.close(); throw error }
}
if (import.meta.main) {
  try {
    const instance = await startBioServer()
    console.log(`BioEvidence account service: ${instance.boundary.publicOrigin}`)
    const shutdown = () => { void instance.stop().then(() => process.exit(0)).catch(() => process.exit(1)) }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch { console.error('BioEvidence service could not start. Check service settings, TLS and the owned data directory.'); process.exitCode = 1 }
}
