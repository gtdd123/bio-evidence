import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { join, relative, sep, isAbsolute } from 'node:path'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
import { SqliteResearchRepository } from '../../server-core/src/research/sqlite-repository'
import { closeBioResources } from './bio-lifecycle'

test('a run shutdown failure still closes all later resources and releases the real database writer lock', async () => {
  const parent = realpathSync.native(resolveConfigDir()), root = mkdtempSync(join(parent, 't14-shutdown-')), file = join(root, 'research.sqlite')
  const repository = new SqliteResearchRepository(file), calls: string[] = []
  try {
    await expect(closeBioResources({ repository: { close: () => { calls.push('repository'); repository.close() } },
      stopMaintenance: () => { calls.push('maintenance') }, server: { close: () => { calls.push('server') } },
      runs: { close: async () => { calls.push('runs'); throw Error('Synthetic interruption persistence failure') } },
      modelWorker: { close: async () => { calls.push('model') } }, documentHttp: { close: async () => { calls.push('http'); throw Error('Synthetic second failure') } },
      snapshots: { close: async () => { calls.push('snapshots') } }, previews: { close: async () => { calls.push('previews') } },
    })).rejects.toMatchObject({ code: 'BIO_STORAGE_UNAVAILABLE' })
    expect(calls).toEqual(['maintenance', 'server', 'runs', 'model', 'http', 'snapshots', 'previews', 'repository'])
    new SqliteResearchRepository(file).close()
  } finally {
    repository.close()
    const offset = relative(parent, realpathSync.native(root))
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned cleanup boundary')
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
test('partial startup cleanup closes only constructed resources and preserves safe failure reporting', async () => {
  const calls: string[] = []
  await closeBioResources({ server: { close: () => { calls.push('server') } }, previews: { close: async () => { calls.push('previews') } }, repository: { close: () => { calls.push('repository') } } })
  expect(calls).toEqual(['server', 'previews', 'repository'])
})
