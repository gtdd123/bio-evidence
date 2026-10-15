import { randomUUID } from 'node:crypto'
import { RESEARCH_CHANNELS as R, ResearchError, parseResearchRequest, parseContract, SessionSchema,
  SourceSchema, sameScope, mergePolicies, type ResearchRepository, type Actor, type ResearchRequestChannel,
} from '@bio-evidence/research-core'
import type { WsRpcServer } from '../transport/server'
import type { RequestContext } from '../transport/types'
import { ResearchAuthorizationGate } from './authorization-gate'
import type { MaterialsService } from './materials-service'
import type { MaterialPreviewService } from './material-preview'
import type { LiteratureService } from './literature-service'
import type { SourceSnapshotService } from './source-snapshots'
import type { ArtifactsService } from './artifacts-service'
export function registerResearchRpcProfile(server: WsRpcServer, repository: ResearchRepository, materials?: MaterialsService, previews?: MaterialPreviewService, literature?: LiteratureService, snapshots?: SourceSnapshotService, artifacts?: ArtifactsService) {
  const gate = new ResearchAuthorizationGate(repository, materials, previews, literature, snapshots, artifacts)
  server.setAuthorizationGate(gate)
  const handlers = new Map<string, (current: Actor, input: any) => unknown>()
  const actor = (context: RequestContext): Actor => {
    if (!context.actor) throw new ResearchError('BIO_ACCESS_DENIED')
    return context.actor
  }
  const register = <C extends ResearchRequestChannel>(channel: C, handler: (current: Actor, input: ReturnType<typeof parseResearchRequest<C>>) => unknown) => {
    gate.enable(channel)
    handlers.set(channel, handler)
    server.handle(channel, (context, ...args) => {
      if (args.length !== 1) throw new ResearchError('BIO_INPUT_INVALID')
      return handler(actor(context), parseResearchRequest(channel, args[0]))
    })
  }
  if (materials) {
    register(R.LIST_MATERIAL_GRANTS, (current, input) => materials.listGrants(current, input.scope))
    register(R.REGISTER_MATERIAL, (current, input) => materials.registerRoot(current, input.grantId, input.relativeDir))
    register(R.LIST_MATERIALS, (current, input) => materials.listRoots(current, input.scope, input.pageSize, input.cursor))
    register(R.GET_MATERIAL, (current, input) => materials.getRoot(current, input.rootId))
    register(R.INDEX_MATERIAL_DIRECTORY, async (current, input) => {
      await materials.indexDirectory(current, input.rootId, input.relativeDir)
      return { rootId: input.rootId, generation: materials.directoryGeneration(current, input.rootId, input.relativeDir) }
    })
    register(R.LIST_MATERIAL_DIRECTORY, (current, input) => materials.list(current, input.rootId, input.relativeDir, input.pageSize, input.cursor))
    register(R.SEARCH_MATERIAL_TEXT, (current, input) => materials.searchText(current, input.rootId, input.query))
    register(R.GET_MATERIAL_INDEX, (current, input) => materials.indexState(current, input.rootId, input.relativeDir))
    register(R.GET_MATERIAL_ANNOTATION, (current, input) => materials.annotation(current, input.rootId, input.relativeDir, input.generation, input.fileId))
    register(R.SAVE_MATERIAL_ANNOTATION, (current, input) => materials.saveAnnotation(current, input.rootId, input.relativeDir, input.generation, input.fileId, input.expectedRevision, input.note, input.tags))
  }
  if (materials && previews) register(R.GET_MATERIAL_IMAGE, (current, input) => previews.preview(current, input.rootId, input.relativeDir, input.generation, input.fileId, input.kind, input.frameIndex))
  if (literature) {
    register(R.SEARCH, (current, input) => literature.search(current, input))
    register(R.SELECT_SOURCE, (current, input) => literature.select(current, input))
    register(R.GET_SOURCE, (current, input) => repository.get(current, 'source', input.sourceId))
    register(R.GET_SNAPSHOT, (current, input) => repository.get(current, 'snapshot', input.snapshotId))
  }
  if (snapshots) {
    register(R.READ_SOURCE_TEXT, (current, input) => snapshots.readOpenText(current, input))
    if (materials) register(R.IMPORT_MATERIAL_PDF, (current, input) => snapshots.importMaterialPdf(current, input))
  }
  if (artifacts) {
    register(R.CREATE_EVIDENCE, (current, input) => artifacts.createEvidence(current, input))
    register(R.SAVE_EVIDENCE, (current, input) => artifacts.saveEvidence(current, input))
    register(R.CREATE_REPORT, (current, input) => artifacts.createReport(current, input))
    register(R.SAVE_REPORT, (current, input) => artifacts.saveReport(current, input))
    register(R.GET_EVIDENCE, (current, input) => artifacts.evidenceView(current, input.revisionId))
    register(R.GET_REPORT, (current, input) => artifacts.reportView(current, input.revisionId))
    register(R.LIST_ARTIFACTS, (current, input) => artifacts.list(current, input.sessionId, input.pageSize, input.cursor))
    register(R.REVIEW_ARTIFACT, (current, input) => artifacts.review(current, input))
    register(R.CONFIRM_SOURCE_METADATA, (current, input) => artifacts.confirmSourceMetadata(current, input.sourceId, input.expectedRevision))
    register(R.EXPORT_EVIDENCE, (current, input) => artifacts.exportEvidence(current, input.revisionId))
    register(R.EXPORT_REPORT, (current, input) => artifacts.exportReport(current, input.revisionId))
  }
  register(R.LIST_SPACES, current => repository.listSpaces(current))
  register(R.READ_AUDIT, (current, input) => repository.readAudit(current, input.scope, input.pageSize, input.afterSequence))
  register(R.CREATE_PROJECT, (current, input) => repository.createProject(current, randomUUID(), input.name))
  register(R.LIST_MEMBERS, (current, input) => repository.listMembers(current, input.projectId))
  register(R.INVITE_MEMBER, (current, input) => {
    const result = repository.inviteMember(current, input.projectId, input.username, input.role, input.expectedRevision)
    server.refreshAuthorization(); return result
  })
  register(R.SET_MEMBER, (current, input) => {
    const result = repository.setMember(current, input.projectId, input.userId, input.role, input.active, input.expectedRevision)
    server.refreshAuthorization(); return result
  })
  register(R.CREATE_SESSION, (current, input) => {
    repository.authorizeScope(current, input.scope, 'write')
    const sources = input.sourceIds.map(id => parseContract(SourceSchema, repository.get(current, 'source', id)))
    if (sources.some(source => !sameScope(source.scope, input.scope))) throw new ResearchError('BIO_ACCESS_DENIED')
    // An empty session contains no material. Cloud operations independently
    // require nonempty, repository-resolved public references in T13.
    const policy = sources.length ? mergePolicies(sources.map(source => source.policy)) : 'public'
    return repository.put(current, 'session', { id: randomUUID(), ownerId: current.userId, scope: input.scope,
      policy, selectedSourceIds: input.sourceIds, name: input.name, revision: 1, createdAt: Date.now() })
  })
  register(R.GET_SESSION, (current, input) => {
    repository.authorizeResource(current, 'session', input.sessionId, 'read')
    return parseContract(SessionSchema, repository.get(current, 'session', input.sessionId))
  })
  register(R.LIST_SESSIONS, (current, input) => repository.listSessions(current, input.scope, input.pageSize, input.cursor))
  return {
    gate,
    registerFeature: register,
    dispatch: async (current: Actor, channel: ResearchRequestChannel, input: unknown, refresh: (actor: Actor) => Actor) => {
      gate.authorizeRequest(current, channel, [input])
      const handler = handlers.get(channel)
      if (!handler) throw new ResearchError('BIO_ACCESS_DENIED')
      const result = await handler(current, parseResearchRequest(channel, input))
      const fresh = refresh(current); gate.authorizeResponse(fresh, channel, [input], result)
      return result
    },
  }
}
