import { expect, test } from 'bun:test'
import { bioCapabilities, runProgress, spaceAccessChanged } from './capabilities'

test('artifact editing does not grant execution of another member session or directory management', () => {
  const member = bioCapabilities('editor', 'bob', 'alice', 'alice')
  expect(member).toEqual({ writeArtifacts: true, executeSession: false, cancelRun: false, manageMaterials: false })
})
test('a viewer who owns the run can cancel without gaining edit or execution access', () => {
  expect(bioCapabilities('viewer', 'alice', 'alice', 'alice')).toEqual({ writeArtifacts: false, executeSession: false, cancelRun: true, manageMaterials: false })
})
test('an owner manages materials but still cannot execute another member session or cancel their run', () => {
  expect(bioCapabilities('owner', 'alice', 'bob', 'bob')).toEqual({ writeArtifacts: true, executeSession: false, cancelRun: false, manageMaterials: true })
  expect(bioCapabilities('editor', 'alice', 'alice', 'alice').executeSession).toBe(true)
})
test('prepared source counts use unique persisted IDs and never imply whole-paper reading', () => {
  expect(runProgress({ sourceIds: ['a', 'a', 'b'] }, [{ id: 'prepare', state: 'completed' }])).toEqual({ preparedSources: 2, totalSources: 2 })
  expect(runProgress({ sourceIds: ['a', 'b'] }, [])).toEqual({ preparedSources: 0, totalSources: 2 })
})
test('successful workspace refresh still signals revoked membership or a changed role', () => {
  const personal = { scope: { kind: 'personal' as const, ownerId: 'bob' }, role: 'owner' as const }
  const project = { scope: { kind: 'project' as const, projectId: 'lab' }, role: 'editor' as const }
  expect(spaceAccessChanged([personal, project], [personal])).toBe(true)
  expect(spaceAccessChanged([project], [{ ...project, role: 'viewer' }])).toBe(true)
  expect(spaceAccessChanged([personal], [personal, project])).toBe(false)
  expect(spaceAccessChanged([personal, project], [project, personal])).toBe(false)
})
