#!/usr/bin/env bun
import '../../../scripts/bio-runtime-guard.mjs'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { createOwnedShutdown, finishOwnedShutdown } from './owned-shutdown'
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
import { createBioUiHttpAdapter } from '../../server-core/src/research/ui-http'
import { fileURLToPath } from 'node:url'
import { ArtifactsService } from '../../server-core/src/research/artifacts-service'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { ResearchConnectionsService } from '../../server-core/src/research/model-connections'
import { PublicInputService } from '../../server-core/src/research/public-input'
import { PublicModelWorkerService } from '../../server-core/src/research/public-model-worker'
import { PublicModelExecutor } from '../../server-core/src/research/public-model-executor'
import { ResearchRunService } from '../../server-core/src/research/research-run-service'
import { SessionProjectionService } from '../../server-core/src/research/projection-service'
import { SessionManager } from '../../server-core/src/sessions/SessionManager'
import { closeBioResources, type BioResources } from './bio-lifecycle'
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
export async function startBioServer(options: { uiRoot?: string } = {}) {
  const settingsFile = join(resolveConfigDir(), 'service.json')
  const settings = Settings.parse(existsSync(settingsFile) ? JSON.parse(readOwnedFile(settingsFile)) : {})
  const repository = new SqliteResearchRepository(join(resolveConfigDir(), 'research.sqlite'))
  const resources: BioResources = { repository }
  try {
    let materialHttp: ReturnType<typeof createMaterialsHttpAdapter> | undefined
    let documentHttp: ReturnType<typeof createDocumentsHttpAdapter> | undefined
    let uiHttp: ReturnType<typeof createBioUiHttpAdapter> | undefined
    const instance = await createBioAuthorityServer(repository, { ...settings, additionalHttpHandler: (request, response) => documentHttp?.(request, response) || materialHttp?.(request, response) || uiHttp?.(request, response) || false, tls: settings.tls ? {
      cert: readOwnedFile(settings.tls.certPath), key: readOwnedFile(settings.tls.keyPath),
    } : undefined })
    resources.server = instance.server
    const sourceUiRoot = fileURLToPath(new URL('../../../apps/webui/dist/', import.meta.url))
    const uiRoot = options.uiRoot ?? (existsSync(join(sourceUiRoot, 'bio-ui.json')) ? sourceUiRoot : undefined)
    uiHttp = createBioUiHttpAdapter(instance.auth, instance.boundary, uiRoot)
    const materials = new MaterialsService(repository, loadMaterialGrants(), { budgets: settings.materialBudgets, currentActor: actor => {
      const current = instance.auth.resolveActor(actor.authSessionId)
      if (!current || current.userId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED')
      return current
    } })
    const previews = new MaterialPreviewService(materials, settings.imageBudgets)
    resources.previews = previews
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
    resources.snapshots = snapshots
    const currentActor = (actor: Actor) => {
      const current = instance.auth.resolveActor(actor.authSessionId)
      if (!current || current.userId !== actor.userId) throw new ResearchError('BIO_ACCESS_DENIED')
      return current
    }
    const connections = new ResearchConnectionsService(repository, getCredentialManager(), currentActor)
    const publicInputs = new PublicInputService(repository, connections.broker, { currentActor })
    const modelWorker = new PublicModelWorkerService()
    resources.modelWorker = modelWorker
    const modelExecutor = new PublicModelExecutor(repository, publicInputs, connections.broker, modelWorker)
    repository.recoverResearchRuns()
    // Owned execution does not inherit the submitting login's expiration or socket.
    const executionConnections = new ResearchConnectionsService(repository, getCredentialManager())
    const executionInputs = new PublicInputService(repository, executionConnections.broker)
    const executionModel = new PublicModelExecutor(repository, executionInputs, executionConnections.broker, modelWorker)
    const workspace = () => join(resolveConfigDir(), 'research-workspace')
    const sessionManager = new SessionManager()
    sessionManager.configureResearchProjection(new SessionProjectionService(repository, workspace))
    sessionManager.setEventSink((channel, target, ...args) => instance.server.push(channel, target, ...args))
    const runs = new ResearchRunService(repository, executionInputs, executionModel, new ArtifactsService(repository), sessionManager, workspace)
    resources.runs = runs
    const profile = registerResearchRpcProfile(instance.server, repository, materials, previews, literature, snapshots, new ArtifactsService(repository), connections, runs)
    materialHttp = createMaterialsHttpAdapter(profile, instance.auth, instance.boundary, { materials, previews })
    documentHttp = createDocumentsHttpAdapter(snapshots, instance.auth, instance.boundary)
    resources.documentHttp = documentHttp
    await runs.recoverProjections()
    await instance.server.listen()
    const publish = () => { try { repository.publishResearchOutbox(event => sessionManager.publishResearchEvent(event)) } catch { /* retain pending outbox rows for the next pass */ } }
    publish()
    const outboxTimer = setInterval(() => { publish(); void runs.recoverProjections().catch(() => {}) }, 500); outboxTimer.unref()
    resources.stopMaintenance = () => clearInterval(outboxTimer)
    let stopPromise: Promise<void> | undefined
    const stop = () => stopPromise ??= closeBioResources(resources)
    return { ...instance, profile, stop, research: { connections, publicInputs, modelWorker, modelExecutor, runs, sessionManager } }
  } catch (error) { try { await closeBioResources(resources) } catch { /* all constructed resources were attempted; preserve the startup failure */ } throw error }
}
if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(argument => argument !== '--control-stdio')) throw Error('Unknown service argument')
    const instance = await startBioServer()
    console.log(`BioEvidence account service: ${instance.boundary.publicOrigin}`)
    const control = createOwnedShutdown(instance.stop, finishOwnedShutdown, process.argv.includes('--control-stdio') ? process.stdin : undefined)
    const shutdown = () => { void control.request(0) }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch { console.error('BioEvidence service could not start. Check service settings, TLS and the owned data directory.'); process.exitCode = 1 }
}
