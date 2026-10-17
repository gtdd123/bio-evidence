import { expect, test } from 'bun:test'
import { materialNoteDraft, materialNoteContent } from './material-note-draft'
test('a concurrent note revision cannot silently rebase an older unsaved draft', () => {
  const original = { fileId: 'file', revision: 0, note: '', tags: [], policy: 'restricted' as const }
  const draft = { ...materialNoteDraft(original), note: 'Alice unsaved text', tagText: 'alice' }
  const current = { ...original, revision: 1, note: 'Bob saved text', tags: ['bob'] }
  const restored = materialNoteDraft(current, JSON.stringify(draft))
  expect(materialNoteContent(restored)).toEqual({ expectedRevision: 0, note: 'Alice unsaved text', tags: ['alice'] })
  expect(materialNoteContent({ ...restored, baseRevision: current.revision })).toEqual({ expectedRevision: 1, note: 'Alice unsaved text', tags: ['alice'] })
  expect(materialNoteDraft(current)).toEqual({ baseRevision: 1, note: 'Bob saved text', tagText: 'bob' })
})
test('excess tags reach the server validator instead of being silently dropped', () => {
  const tags = Array.from({ length: 21 }, (_, index) => `tag-${index}`)
  expect(materialNoteContent({ baseRevision: 1, note: '', tagText: tags.join(',') }).tags).toEqual(tags)
})
