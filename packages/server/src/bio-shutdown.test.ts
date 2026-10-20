import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { SqliteResearchRepository } from '../../server-core/src/research/sqlite-repository'
import { startOwnedService as start, exitWithin } from './__fixtures__/owned-service'

test('owned stdio shutdown is idempotent and closes the real service before reporting success', async () => {
  const value = await start('controlled-stop')
  try {
    const sink = value.proc.stdin as Bun.FileSink
    sink.write('{"type":"shutdown"}\n{"type":"shutdown"}\n'); await sink.flush()
    expect(await exitWithin(value.proc)).toBe(0)
    expect(await value.output).toContain('BIOEVIDENCE_STOPPED=0')
    const repository = new SqliteResearchRepository(join(value.root, 'research.sqlite')); repository.close()
  } finally { value.proc.kill(); await value.proc.exited; await value.errors }
}, 20000)

test('loss of the owned supervisor pipe flushes and stops instead of leaving an orphan service', async () => {
  const value = await start('supervisor-eof')
  try {
    ;(value.proc.stdin as Bun.FileSink).end()
    expect(await exitWithin(value.proc)).toBe(1)
    expect(await value.output).toContain('BIOEVIDENCE_STOPPED=1')
    const repository = new SqliteResearchRepository(join(value.root, 'research.sqlite')); repository.close()
  } finally { value.proc.kill(); await value.proc.exited; await value.errors }
}, 20000)

test('a pipe left open without supervisor heartbeats expires and closes the real service safely', async () => {
  const value = await start('supervisor-lease')
  try {
    expect(await exitWithin(value.proc, 8000)).toBe(1)
    expect(await value.output).toContain('BIOEVIDENCE_STOPPED=1')
    const repository = new SqliteResearchRepository(join(value.root, 'research.sqlite')); repository.close()
  } finally { value.proc.kill(); await value.proc.exited; await value.errors }
}, 20000)
