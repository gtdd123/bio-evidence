import { MaterialImageResultSchema, ResearchError, parseContract, type Actor, type MaterialImageResult } from '@bio-evidence/research-core'
import type { MaterialsService } from './materials-service'
import { ImageDecodeService, type ImageDecodeKind, type ImageDecodeOptions } from './image-decode'
export class MaterialPreviewService {
  private active = 0
  private readonly decoder: ImageDecodeService
  private readonly controllers = new Set<AbortController>()
  private closed = false
  constructor(private readonly materials: MaterialsService, options: ImageDecodeOptions = {}, decoder?: ImageDecodeService) { this.decoder = decoder ?? new ImageDecodeService(options) }
  async preview(actor: Actor, rootId: string, relativeDir: string, generation: number, fileId: string, kind: ImageDecodeKind, frameIndex: number, signal?: AbortSignal): Promise<MaterialImageResult> {
    const base = { rootId, generation, fileId, kind, frameIndex, policy: 'restricted' as const }
    const entry = this.materials.fileEntry(actor, rootId, relativeDir, generation, fileId)
    if (this.closed) return { ...base, status: 'unavailable' }
    if (entry.size > this.decoder.limits.maxInputBytes) return { ...base, status: 'budget' }
    if (this.active >= this.decoder.limits.concurrency) return { ...base, status: 'busy' }
    this.active++
    const controller = new AbortController(); this.controllers.add(controller)
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      const file = await this.materials.openFile(actor, rootId, relativeDir, generation, fileId), chunks: Uint8Array[] = []
      let length = 0
      try {
        for await (const chunk of file.chunks(combinedSignal)) {
          length += chunk.length
          if (length > this.decoder.limits.maxInputBytes) return { ...base, status: 'budget' }
          chunks.push(chunk)
        }
      } finally { await file.close() }
      const decoded = await this.decoder.decode(Buffer.concat(chunks), kind, frameIndex, combinedSignal)
      const result = parseContract(MaterialImageResultSchema, { ...decoded, ...base })
      this.validateResult(actor, relativeDir, result)
      return result
    } finally { this.controllers.delete(controller); this.active-- }
  }
  validateResult(actor: Actor, relativeDir: string, result: MaterialImageResult): void {
    parseContract(MaterialImageResultSchema, result)
    this.materials.fileEntry(actor, result.rootId, relativeDir, result.generation, result.fileId)
    if (result.status === 'ok' && (result.kind === 'metadata' ? result.bytes !== undefined : !result.bytes ||
      Math.max(result.width, result.height) > (result.kind === 'thumbnail' ? 256 : 2048))) throw new ResearchError('BIO_INPUT_INVALID')
  }
  async close(): Promise<void> {
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    await this.decoder.close()
  }
}
