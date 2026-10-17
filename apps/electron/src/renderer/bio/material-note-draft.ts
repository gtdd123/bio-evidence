import { z } from 'zod'
import type { MaterialAnnotation } from '@bio-evidence/research-core'

const NoteDraft = z.strictObject({ baseRevision: z.number().int().nonnegative(), note: z.string().max(5000), tagText: z.string().max(2000) })
export function materialNoteDraft(initial: MaterialAnnotation, saved?: string) {
  if (saved) return NoteDraft.parse(JSON.parse(saved))
  return NoteDraft.parse({ baseRevision: initial.revision, note: initial.note, tagText: initial.tags.join(', ') })
}
export function materialNoteContent(draft: ReturnType<typeof materialNoteDraft>) {
  return { expectedRevision: draft.baseRevision, note: draft.note, tags: draft.tagText.split(',').map(value => value.trim()).filter(Boolean) }
}
