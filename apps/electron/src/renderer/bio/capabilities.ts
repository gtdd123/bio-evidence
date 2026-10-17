import type { ResearchSpaceView, ResearchRunView } from '@bio-evidence/research-core'

/** Mirrors server authority for visibility; the server still checks every operation. */
export function bioCapabilities(role: ResearchSpaceView['role'], accountId: string, sessionOwnerId?: string, runActorId?: string) {
  return {
    writeArtifacts: role !== 'viewer',
    executeSession: role !== 'viewer' && sessionOwnerId === accountId,
    cancelRun: runActorId === accountId,
    manageMaterials: role === 'owner',
  }
}

export function runProgress(run: { sourceIds: string[] }, steps: ResearchRunView['steps']) {
  const totalSources = new Set(run.sourceIds).size
  return { preparedSources: steps.some(step => step.id === 'prepare' && step.state === 'completed') ? totalSources : 0, totalSources }
}
type SpaceAccess = Pick<ResearchSpaceView, 'scope' | 'role'>
export function spaceAccessChanged(previous: SpaceAccess[], current: SpaceAccess[]): boolean {
  const key = (space: SpaceAccess) => space.scope.kind === 'personal' ? `personal:${space.scope.ownerId}` : `project:${space.scope.projectId}`
  const roles = new Map(current.map(space => [key(space), space.role]))
  return previous.some(space => roles.get(key(space)) !== space.role)
}
