import { z } from 'zod'
import { RESEARCH_CHANNELS as R, ResearchRequestSchemas, ResearchEventSchema, ResearchError, parseResearchRequest,
  parseContract, ScopeSchema, SessionSchema, SourceSchema, EvidenceRevisionSchema, ReportRevisionSchema, sameScope,
  MaterialRootSchema, MaterialGrantViewSchema, MaterialPageSchema, MaterialSearchResultSchema, MaterialDirectoryStateSchema, MaterialAnnotationSchema,
  MaterialImageResultSchema,
  LiteratureSelectionSchema,
  type Actor, type ResearchRepository, type ResearchRequestChannel, type ResearchScope,
} from '@bio-evidence/research-core'
import { getAllChannelValues } from '@craft-agent/shared/protocol'
import type { TransportAuthorizationGate } from '../transport/types'
import type { MaterialsService } from './materials-service'
import { materialRelativePath } from './material-paths'
import type { MaterialPreviewService } from './material-preview'
import type { LiteratureService } from './literature-service'

/** Every new endpoint still uses this common current-authority resolver. */
export class ResearchAuthorizationGate implements TransportAuthorizationGate {
  private enabled = new Set<ResearchRequestChannel>()
  constructor(private readonly repository: ResearchRepository, private readonly materials?: MaterialsService, private readonly previews?: MaterialPreviewService, private readonly literature?: LiteratureService) {}
  enable(channel: ResearchRequestChannel): void {
    if (!Object.hasOwn(ResearchRequestSchemas, channel)) throw new ResearchError('BIO_ACCESS_DENIED')
    this.enabled.add(channel)
  }
  allowsChannel(channel: string): boolean { return this.enabled.has(channel as ResearchRequestChannel) }
  manifest() {
    return getAllChannelValues().map(channel => ({ channel, status: this.allowsChannel(channel) ? 'enabled' :
      channel === R.EVENT ? 'scoped-event' : Object.hasOwn(ResearchRequestSchemas, channel) ? 'disabled-unimplemented' : 'disabled-legacy' }))
  }
  authorizeRequest(actor: Actor, channel: string, args: unknown[]): void {
    if (!this.allowsChannel(channel)) throw new ResearchError('BIO_ACCESS_DENIED')
    if (args.length !== 1) throw new ResearchError('BIO_INPUT_INVALID')
    const input = parseResearchRequest(channel, args[0]) as Record<string, unknown>
    switch (channel) {
      case R.LIST_MATERIAL_GRANTS: case R.LIST_MATERIALS:
        this.repository.authorizeScope(actor, input.scope as ResearchScope, 'read'); return
      case R.REGISTER_MATERIAL:
        this.repository.materialGrant(actor, input.grantId as string, true); return
      case R.GET_MATERIAL: case R.INDEX_MATERIAL_DIRECTORY: case R.LIST_MATERIAL_DIRECTORY: case R.SEARCH_MATERIAL_TEXT:
      case R.GET_MATERIAL_INDEX: case R.GET_MATERIAL_ANNOTATION:
        this.repository.materialRoot(actor, input.rootId as string); return
      case R.GET_MATERIAL_IMAGE:
        if (!this.materials || !this.previews) throw new ResearchError('BIO_ACCESS_DENIED')
        this.materials.fileEntry(actor, input.rootId as string, input.relativeDir as string, input.generation as number, input.fileId as string); return
      case R.SAVE_MATERIAL_ANNOTATION: {
        const root = this.repository.materialRoot(actor, input.rootId as string)
        this.repository.authorizeScope(actor, root.scope, 'write'); return
      }
      case R.LIST_SPACES: case R.CREATE_PROJECT:
        this.repository.currentAccount(actor); return
      case R.READ_AUDIT:
        this.repository.authorizeScope(actor, input.scope as ResearchScope, (input.scope as ResearchScope).kind === 'project' ? 'manage' : 'read'); return
      case R.LIST_MEMBERS:
        this.repository.authorizeScope(actor, { kind: 'project', projectId: input.projectId as string }, 'read'); return
      case R.INVITE_MEMBER: case R.SET_MEMBER:
        this.repository.authorizeScope(actor, { kind: 'project', projectId: input.projectId as string }, 'manage'); return
      case R.CREATE_SESSION:
        this.repository.authorizeScope(actor, input.scope as ResearchScope, 'write'); return
      case R.LIST_SESSIONS:
        this.repository.authorizeScope(actor, input.scope as ResearchScope, 'read'); return
      case R.GET_SESSION:
        this.repository.authorizeResource(actor, 'session', input.sessionId as string, 'read'); return
      case R.GET_SNAPSHOT:
        this.repository.authorizeResource(actor, 'snapshot', input.snapshotId as string, 'read'); return
      case R.GET_SOURCE:
        this.repository.authorizeResource(actor, 'source', input.sourceId as string, 'read'); return
      case R.SELECT_SOURCE:
        if (!this.literature) throw new ResearchError('BIO_ACCESS_DENIED')
        this.literature.assertPublicSession(actor, input.sessionId as string); return
      case R.GET_RUN: case R.CANCEL_RUN:
        this.repository.authorizeResource(actor, 'run', input.runId as string, channel === R.CANCEL_RUN ? 'cancel' : 'read'); return
      case R.SEARCH: case R.START_RUN:
        this.repository.authorizeResource(actor, 'session', input.sessionId as string, 'execute'); return
      case R.SAVE_EVIDENCE:
        this.repository.authorizeResource(actor, 'evidence', input.evidenceId as string, 'write'); return
      case R.SAVE_REPORT:
        this.repository.authorizeResource(actor, 'report', input.reportId as string, 'write'); return
      default: throw new ResearchError('BIO_ACCESS_DENIED')
    }
  }
  authorizeResponse(actor: Actor, channel: string, args: unknown[], result: unknown): void {
    this.authorizeRequest(actor, channel, args)
    const input = parseResearchRequest(channel, args[0]) as Record<string, unknown>
    if (channel === R.GET_MATERIAL_IMAGE) {
      const image = parseContract(MaterialImageResultSchema, result)
      if (!this.previews || image.rootId !== input.rootId || image.fileId !== input.fileId || image.generation !== input.generation || image.frameIndex !== input.frameIndex || image.kind !== input.kind) throw new ResearchError('BIO_ACCESS_DENIED')
      this.previews.validateResult(actor, input.relativeDir as string, image)
    }
    if (channel === R.REGISTER_MATERIAL || channel === R.GET_MATERIAL) {
      const root = parseContract(MaterialRootSchema, result), authoritative = this.repository.materialRoot(actor, root.id)
      if (JSON.stringify(root) !== JSON.stringify(authoritative) || (channel === R.GET_MATERIAL ? root.id !== input.rootId : root.grantId !== input.grantId)) throw new ResearchError('BIO_ACCESS_DENIED')
      if (channel === R.REGISTER_MATERIAL && root.relativeDir !== materialRelativePath(input.relativeDir as string)) throw new ResearchError('BIO_ACCESS_DENIED')
    } else if (channel === R.LIST_MATERIAL_GRANTS) {
      for (const grant of parseContract(z.array(MaterialGrantViewSchema).max(1000), result)) {
        const authoritative = this.repository.materialGrant(actor, grant.id)
        if (!sameScope(authoritative.scope, grant.scope) || !sameScope(grant.scope, input.scope as ResearchScope)) throw new ResearchError('BIO_ACCESS_DENIED')
      }
      if (!this.materials || JSON.stringify(result) !== JSON.stringify(this.materials.listGrants(actor, input.scope as ResearchScope))) throw new ResearchError('BIO_ACCESS_DENIED')
    } else if (channel === R.LIST_MATERIALS) {
      const page = parseContract(z.strictObject({ items: z.array(MaterialRootSchema).max(200), nextCursor: z.string().optional() }), result)
      if (page.items.length > (input.pageSize as number)) throw new ResearchError('BIO_ACCESS_DENIED')
      for (const root of page.items) {
        const authoritative = this.repository.materialRoot(actor, root.id)
        if (!sameScope(root.scope, input.scope as ResearchScope) || JSON.stringify(root) !== JSON.stringify(authoritative)) throw new ResearchError('BIO_ACCESS_DENIED')
      }
    } else if (channel === R.LIST_MATERIAL_DIRECTORY) {
      const page = parseContract(MaterialPageSchema, result)
      if (!this.materials || JSON.stringify(page) !== JSON.stringify(this.materials.list(actor, input.rootId as string, input.relativeDir as string, input.pageSize as number, input.cursor as string | undefined))) throw new ResearchError('BIO_ACCESS_DENIED')
    } else if (channel === R.SEARCH_MATERIAL_TEXT) {
      if (!this.materials) throw new ResearchError('BIO_ACCESS_DENIED')
      this.materials.validateSearchResult(actor, input.rootId as string, parseContract(MaterialSearchResultSchema, result))
    } else if (channel === R.GET_MATERIAL_INDEX) {
      const state = parseContract(MaterialDirectoryStateSchema, result)
      if (!this.materials || JSON.stringify(state) !== JSON.stringify(this.materials.indexState(actor, input.rootId as string, input.relativeDir as string))) throw new ResearchError('BIO_ACCESS_DENIED')
    } else if (channel === R.GET_MATERIAL_ANNOTATION || channel === R.SAVE_MATERIAL_ANNOTATION) {
      const note = parseContract(MaterialAnnotationSchema, result)
      if (!this.materials || note.fileId !== input.fileId || JSON.stringify(note) !== JSON.stringify(this.materials.annotation(actor, input.rootId as string,
        input.relativeDir as string, input.generation as number, input.fileId as string))) throw new ResearchError('BIO_ACCESS_DENIED')
    } else if (channel === R.INDEX_MATERIAL_DIRECTORY) {
      const value = parseContract(z.strictObject({ rootId: z.string(), generation: z.number().int().positive() }), result)
      if (value.rootId !== input.rootId) throw new ResearchError('BIO_ACCESS_DENIED')
      const state = this.materials?.indexState(actor, input.rootId as string, input.relativeDir as string)
      if (!state || state.status !== 'complete' || state.generation !== value.generation) throw new ResearchError('BIO_REVISION_CONFLICT')
    }
    if (channel === R.CREATE_SESSION) {
      const value = parseContract(SessionSchema, result), binding = this.repository.authorizeResource(actor, 'session', value.id, 'write')
      if (value.ownerId !== actor.userId || binding.ownerId !== actor.userId || !sameScope(value.scope, input.scope as ResearchScope) ||
        !sameScope(binding.scope, value.scope) || value.name !== input.name || value.revision !== 1) throw new ResearchError('BIO_ACCESS_DENIED')
    } else if (channel === R.CREATE_PROJECT) {
      const value = parseContract(z.strictObject({ id: z.string(), name: z.string(), revision: z.number() }), result)
      const authoritative = this.repository.listSpaces(actor).find(space => space.scope.kind === 'project' && space.scope.projectId === value.id)
      if (!authoritative || authoritative.role !== 'owner' || value.revision !== 1 || authoritative.revision !== value.revision ||
        value.name !== input.name || authoritative.name !== value.name) throw new ResearchError('BIO_ACCESS_DENIED')
    } else if (channel === R.LIST_MEMBERS) {
      const authoritative = this.repository.listMembers(actor, input.projectId as string)
      if (JSON.stringify(result) !== JSON.stringify(authoritative)) throw new ResearchError('BIO_ACCESS_DENIED')
    } else if (channel === R.READ_AUDIT) {
      const entries = parseContract(z.array(z.strictObject({ sequence: z.number().int().positive(), actorId: z.string(), createdAt: z.number().int().nonnegative(),
        action: z.string(), outcome: z.string(), resourceId: z.string().nullable(),
      })).max(200), result)
      if (entries.length > (input.pageSize as number) || entries.some(row => row.sequence <= (input.afterSequence as number))) throw new ResearchError('BIO_ACCESS_DENIED')
      const authoritative = this.repository.readAuditEntries(actor, input.scope as ResearchScope, entries.map(row => row.sequence))
      if (JSON.stringify(entries) !== JSON.stringify(authoritative)) throw new ResearchError('BIO_ACCESS_DENIED')
    } else if (channel === R.SEARCH) {
      if (!this.literature) throw new ResearchError('BIO_ACCESS_DENIED')
      this.literature.validateSearch(actor, input as { sessionId: string; query: string; pageSize?: number }, result)
    } else if (channel === R.SELECT_SOURCE) {
      const selection = parseContract(LiteratureSelectionSchema, result)
      const session = parseContract(SessionSchema, this.repository.get(actor, 'session', input.sessionId as string))
      for (const source of selection.status === 'selected' ? [selection.source] : selection.candidates) {
        if (source.policy !== 'public' || !sameScope(source.scope, session.scope) || JSON.stringify(source) !== JSON.stringify(this.repository.get(actor, 'source', source.id))) throw new ResearchError('BIO_ACCESS_DENIED')
      }
      if (selection.status === 'selected') {
        if (!session.selectedSourceIds?.includes(selection.source.id) || JSON.stringify(session) !== JSON.stringify(selection.session)) throw new ResearchError('BIO_ACCESS_DENIED')
        if (selection.snapshot && (selection.snapshot.sourceId !== selection.source.id || JSON.stringify(selection.snapshot) !== JSON.stringify(this.repository.get(actor, 'snapshot', selection.snapshot.id)))) throw new ResearchError('BIO_ACCESS_DENIED')
      }
    } else if (channel === R.SAVE_EVIDENCE || channel === R.SAVE_REPORT) {
      const kind = channel === R.SAVE_EVIDENCE ? 'evidence' : 'report'
      const value = channel === R.SAVE_EVIDENCE ? parseContract(EvidenceRevisionSchema, result) : parseContract(ReportRevisionSchema, result)
      const entityId = 'evidenceId' in value ? value.evidenceId : value.reportId
      const requested = (input.evidenceId ?? input.reportId) as string
      const target = this.repository.authorizeResource(actor, kind, requested, 'write')
      const stored = this.repository.authorizeResource(actor, kind, value.id, 'read')
      if (entityId !== requested || !sameScope(target.scope, stored.scope) || !sameScope(value.scope, stored.scope)) throw new ResearchError('BIO_ACCESS_DENIED')
    }
    if (channel === R.GET_SESSION || channel === R.GET_SNAPSHOT || channel === R.GET_RUN || channel === R.GET_SOURCE) {
      const kind = channel === R.GET_SESSION ? 'session' : channel === R.GET_SNAPSHOT ? 'snapshot' : channel === R.GET_SOURCE ? 'source' : 'run'
      const requestedId = (input.sessionId ?? input.snapshotId ?? input.runId ?? input.sourceId) as string
      const value = parseContract(z.object({ id: z.string(), scope: ScopeSchema }).passthrough(), result)
      const binding = this.repository.authorizeResource(actor, kind, requestedId, 'read')
      if (value.id !== binding.id || !sameScope(value.scope, binding.scope)) throw new ResearchError('BIO_ACCESS_DENIED')
      if (JSON.stringify(result) !== JSON.stringify(this.repository.get(actor, kind, requestedId))) throw new ResearchError('BIO_ACCESS_DENIED')
    }
    if (channel === R.LIST_SPACES) {
      for (const space of parseContract(z.array(z.object({ scope: ScopeSchema }).passthrough()), result)) {
        this.repository.authorizeScope(actor, space.scope, 'read')
      }
    } else if (channel === R.LIST_SESSIONS) {
      for (const session of parseContract(z.object({ items: z.array(z.object({ id: z.string(), scope: ScopeSchema }).passthrough()) }).passthrough(), result).items) {
        const binding = this.repository.authorizeResource(actor, 'session', session.id, 'read')
        if (!sameScope(binding.scope, session.scope) || !sameScope(binding.scope, input.scope as ResearchScope)) throw new ResearchError('BIO_ACCESS_DENIED')
      }
    }
  }
  allowsEvent(actor: Actor, channel: string, args: unknown[]): boolean {
    if (channel !== R.EVENT || args.length !== 1) return false
    const event = parseContract(ResearchEventSchema, args[0])
    const kind = event.kind === 'run-changed' ? 'run' : event.kind === 'evidence-changed' ? 'evidence' : event.kind === 'report-changed' ? 'report' : 'session'
    const resource = this.repository.authorizeResource(actor, kind, event.resourceId, 'read')
    const session = this.repository.authorizeResource(actor, 'session', event.sessionId, 'read')
    return sameScope(resource.scope, event.scope) && sameScope(session.scope, event.scope) &&
      (!resource.sessionId || resource.sessionId === event.sessionId) && (kind !== 'session' || resource.id === event.sessionId)
  }
}
