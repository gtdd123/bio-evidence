import { randomUUID } from 'node:crypto'
import { RESEARCH_CHANNELS as R, ResearchError, parseResearchRequest, parseContract, SessionSchema,
  SourceSchema, sameScope, mergePolicies, type ResearchRepository, type Actor, type ResearchRequestChannel,
} from '@bio-evidence/research-core'
import type { WsRpcServer } from '../transport/server'
import type { RequestContext } from '../transport/types'
import { ResearchAuthorizationGate } from './authorization-gate'
export function registerResearchRpcProfile(server: WsRpcServer, repository: ResearchRepository) {
  const gate = new ResearchAuthorizationGate(repository)
  server.setAuthorizationGate(gate)
  const actor = (context: RequestContext): Actor => {
    if (!context.actor) throw new ResearchError('BIO_ACCESS_DENIED')
    return context.actor
  }
  const register = <C extends ResearchRequestChannel>(channel: C, handler: (current: Actor, input: ReturnType<typeof parseResearchRequest<C>>) => unknown) => {
    gate.enable(channel)
    server.handle(channel, (context, ...args) => {
      if (args.length !== 1) throw new ResearchError('BIO_INPUT_INVALID')
      return handler(actor(context), parseResearchRequest(channel, args[0]))
    })
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
      policy, name: input.name, revision: 1, createdAt: Date.now() })
  })
  register(R.GET_SESSION, (current, input) => {
    repository.authorizeResource(current, 'session', input.sessionId, 'read')
    return parseContract(SessionSchema, repository.get(current, 'session', input.sessionId))
  })
  register(R.LIST_SESSIONS, (current, input) => repository.listSessions(current, input.scope, input.pageSize, input.cursor))
  return {
    gate,
    registerFeature: register,
  }
}
