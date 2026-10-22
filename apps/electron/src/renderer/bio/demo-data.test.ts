import { expect, test } from 'bun:test'
import { demoCitation, demoCitationMatches, demoExcerpt } from './demo-data'
test('demo citations resolve only exact snapshot, block and UTF-16 text', () => {
  expect(demoCitationMatches(demoCitation)).toBe(true)
  expect(demoCitationMatches({ ...demoCitation, snapshotId: 'another' })).toBe(false)
  expect(demoCitationMatches({ ...demoCitation, quote: 'incorrect' })).toBe(false)
  expect(demoCitationMatches({ ...demoCitation, end: demoExcerpt.length + 1 })).toBe(false)
  expect(demoCitationMatches({ ...demoCitation, start: -1 })).toBe(false)
})
