import type { FileHandle } from 'node:fs/promises'
import { ResearchError, type MaterialEntry } from '@bio-evidence/research-core'
/** Server-internal descriptor; callers receive only entry metadata and bytes. */
export class ControlledMaterialFile {
  private isClosed = false
  constructor(readonly entry: MaterialEntry, private readonly handle: FileHandle, private readonly validate: () => Promise<void>) {}
  get closed(): boolean { return this.isClosed }
  async verify(): Promise<void> {
    if (this.isClosed) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
    await this.validate()
  }
  async *chunks(signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    let offset = 0
    try {
      while (offset < this.entry.size) {
        if (signal?.aborted) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
        await this.verify()
        const buffer = Buffer.alloc(Math.min(65536, this.entry.size - offset))
        const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, offset)
        await this.verify()
        if (signal?.aborted) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
        if (bytesRead === 0) throw new ResearchError('BIO_REVISION_CONFLICT')
        offset += bytesRead; yield buffer.subarray(0, bytesRead)
      }
      await this.verify()
    } finally { await this.close() }
  }
  async close(): Promise<void> { if (!this.isClosed) { this.isClosed = true; await this.handle.close() } }
}
