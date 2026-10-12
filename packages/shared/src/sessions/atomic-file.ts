import { randomUUID } from 'node:crypto'
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import { open, rename } from 'node:fs/promises'

/** Never pre-delete the destination or reuse an orphan temporary file. */
export async function replaceFileDurably(file: string, content: string, current: () => boolean = () => true,
  replace: typeof rename = rename): Promise<void> {
  const temp = `${file}.tmp-${randomUUID()}`
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
  if (!current()) throw new Error('SESSION_WRITE_CANCELLED')
  // Node rename replaces an existing regular file on Windows. If sharing flags
  // prevent it, reject and retain both the old file and the complete temp.
  await replace(temp, file)
}

export function replaceFileDurablySync(file: string, content: string): void {
  const temp = `${file}.tmp-${randomUUID()}`
  const fd = openSync(temp, 'wx', 0o600)
  try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, file)
}
