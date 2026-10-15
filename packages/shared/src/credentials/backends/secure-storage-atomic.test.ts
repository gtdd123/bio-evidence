import { expect, test, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveConfigDir } from '../../config/namespace.mjs'
import { SecureStorageBackend } from './secure-storage'

test('failed credential replacement preserves the original file and invalidates uncommitted cache', async () => {
  const root = fs.realpathSync.native(resolveConfigDir()), offset = relative(resolve('.runtime/test'), root)
  if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Credentials test requires an owned test namespace')
  const store = new SecureStorageBackend(), file = join(root, 'credentials.enc')
  const original = { type: 'llm_api_key' as const, connectionSlug: `atomic-before-${randomUUID()}` }, staged = { type: 'llm_api_key' as const, connectionSlug: `atomic-staged-${randomUUID()}` }
  await store.set(original, { value: 'synthetic-existing-key' })
  const before = fs.readFileSync(file), rename = fs.renameSync
  let attempts = 0
  const replacement = spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    if (String(target) === file) { expect(dirname(String(source))).toBe(root); attempts++; throw new Error('Synthetic replacement failure') }
    return rename(source, target)
  })
  try {
    await expect(store.set(staged, { value: 'synthetic-staged-key' })).rejects.toThrow('Synthetic replacement failure')
    expect(attempts).toBe(1)
    expect(fs.readFileSync(file).equals(before)).toBe(true)
    expect((await store.get(original))?.value).toBe('synthetic-existing-key')
    expect(await store.get(staged)).toBeNull()
    expect(fs.readdirSync(root).filter(name => name.startsWith('credentials.enc.') && name.endsWith('.tmp'))).toEqual([])
    const reopened = new SecureStorageBackend()
    expect((await reopened.get(original))?.value).toBe('synthetic-existing-key')
    expect(await reopened.get(staged)).toBeNull()
  } finally {
    replacement.mockRestore()
    store.clearCache()
    store.deleteSync(original); store.deleteSync(staged)
  }
})
