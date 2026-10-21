import type { MaterialImageResult } from '@bio-evidence/research-core'

export interface MaterialPreviewState {
  frameIndex: number
  status: 'loading' | 'ready' | 'unavailable' | 'error'
  url: string
  result?: MaterialImageResult
  error?: unknown
}

interface MaterialPreviewOptions {
  pages: number
  file: { rootId: string; fileId: string; generation: number }
  loadFrame(index: number): Promise<MaterialImageResult>
  createUrl(bytes: Uint8Array): string
  revokeUrl(url: string): void
  changed(state: MaterialPreviewState): void
}

/** Owns the URL and request generation for one authorized file revision. */
export class MaterialPreviewController {
  private version = 0
  private closed = false
  private url = ''
  constructor(private readonly options: MaterialPreviewOptions) {}
  async load(index: number): Promise<void> {
    if (this.closed) return
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.options.pages) throw new RangeError('Frame is outside the saved metadata range')
    const version = ++this.version
    this.clearUrl()
    this.options.changed({ frameIndex: index, status: 'loading', url: '' })
    try {
      const result = await this.options.loadFrame(index)
      if (this.closed || version !== this.version) return
      const file = this.options.file
      if (result.rootId !== file.rootId || result.fileId !== file.fileId || result.generation !== file.generation || result.kind !== 'view' || result.frameIndex !== index) throw { code: 'BIO_INPUT_INVALID' }
      if (result.status !== 'ok') {
        this.options.changed({ frameIndex: index, status: 'unavailable', url: '', result })
        return
      }
      if (!result.bytes?.length || result.pages !== this.options.pages) throw { code: 'BIO_INPUT_INVALID' }
      this.url = this.options.createUrl(result.bytes)
      this.options.changed({ frameIndex: index, status: 'ready', url: this.url, result })
    } catch (error) {
      if (this.closed || version !== this.version) return
      this.clearUrl()
      this.options.changed({ frameIndex: index, status: 'error', url: '', error })
    }
  }
  close(): void { this.closed = true; this.version++; this.clearUrl() }
  private clearUrl(): void {
    if (this.url) this.options.revokeUrl(this.url)
    this.url = ''
  }
}
