import { z } from 'zod'
import { RESEARCH_CHANNELS as R, ResearchRequestSchemas, ResearchEventSchema, ResearchError, parseResearchRequest,
  parseContract, ScopeSchema, SessionSchema, SourceSchema, EvidenceRevisionSchema, ReportRevisionSchema, sameScope,
  type Actor, type ResearchRepository, type ResearchRequestChannel, type ResearchScope,
} from '@bio-evidence/research-core'
import { getAllChannelValues } from '@craft-agent/shared/protocol'
import type { TransportAuthorizationGate } from '../transport/types'

/** Every new endpoint still uses this common current-authority resolver. */
export class ResearchAuthorizationGate implements TransportAuthorizationGate {
  private enabled = new Set<ResearchRequestChannel>()
  constructor(private readonly repository: ResearchRepository) {}
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
      const sources = parseContract(z.strictObject({ items: z.array(SourceSchema).max(50), nextCursor: z.string().max(2000).optional() }), result)
      const session = this.repository.authorizeResource(actor, 'session', input.sessionId as string, 'execute')
      for (const source of sources.items) {
        const binding = this.repository.authorizeResource(actor, 'source', source.id, 'read')
        if (!sameScope(binding.scope, session.scope) || !sameScope(source.scope, session.scope)) throw new ResearchError('BIO_ACCESS_DENIED')
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
    if (channel === R.GET_SESSION || channel === R.GET_SNAPSHOT || channel === R.GET_RUN) {
      const kind = channel === R.GET_SESSION ? 'session' : channel === R.GET_SNAPSHOT ? 'snapshot' : 'run'
      const requestedId = (input.sessionId ?? input.snapshotId ?? input.runId) as string
      const value = parseContract(z.object({ id: z.string(), scope: ScopeSchema }).passthrough(), result)
      const binding = this.repository.authorizeResource(actor, kind, requestedId, 'read')
      if (value.id !== binding.id || !sameScope(value.scope, binding.scope)) throw new ResearchError('BIO_ACCESS_DENIED')
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
