import { expect, test } from 'bun:test'
import { BioDraftVault, bioDraftOwner } from './drafts'
test('private window drafts separate owners and resource revisions, retain conflict text and enforce a budget', () => {
  const vault = new BioDraftVault(200, 2), key = ['project', 'session', 'evidence', 'revision-1']
  vault.set('alice', key, 'Unsubmitted conflict text')
  expect(vault.get('bob', key)).toBeUndefined()
  expect(vault.get('alice', [...key.slice(0, -1), 'revision-2'])).toBeUndefined()
  expect(vault.get('alice', key)).toBe('Unsubmitted conflict text')
  expect(() => vault.set('alice', key, 'x'.repeat(201))).toThrow('BIO_DRAFT_BUDGET')
  expect(vault.get('alice', key)).toBe('Unsubmitted conflict text')
  vault.set('bob', ['note'], 'note')
  expect(() => vault.set('alice', ['question'], 'question')).toThrow('BIO_DRAFT_BUDGET')
  expect(vault.get('alice', key)).toBe('Unsubmitted conflict text'); expect(vault.get('bob', ['note'])).toBe('note')
  vault.remove('bob', ['note']); expect(vault.get('bob', ['note'])).toBeUndefined()
})
test('equal account and resource IDs on different services cannot recover another origin draft', () => {
  const vault = new BioDraftVault()
  vault.set(bioDraftOwner('https://lab.example', 'alice'), ['session'], 'Private lab note')
  expect(vault.get(bioDraftOwner('https://other.example', 'alice'), ['session'])).toBeUndefined()
  expect(vault.get(bioDraftOwner('https://lab.example', 'alice'), ['session'])).toBe('Private lab note')
})
