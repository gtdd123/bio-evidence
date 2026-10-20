import { z } from 'zod'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
import { buildNamespaceEnv } from '@craft-agent/shared/config/namespace.mjs'
import { MaterialImageBudgetsSchema } from '@bio-evidence/research-core'
export type ImageDecodeKind = 'metadata' | 'thumbnail' | 'view'
const ImageInfo = z.strictObject({ status: z.literal('ok'), width: z.number().int().positive().max(50000000), height: z.number().int().positive().max(50000000),
  pages: z.number().int().positive().max(1000000), frameIndex: z.number().int().nonnegative(), format: z.enum(['png', 'jpeg', 'tiff']) })
const Failure = z.strictObject({ status: z.enum(['invalid', 'unsupported', 'budget', 'timeout', 'busy', 'unavailable']) })
export type ImageDecodeResult = (z.infer<typeof ImageInfo> & { bytes?: Uint8Array }) | z.infer<typeof Failure>
const Options = MaterialImageBudgetsSchema.extend({ workerPath: z.string().optional() })
export type ImageDecodeOptions = z.input<typeof Options>
export class ImageDecodeService {
  private readonly options: z.output<typeof Options>
  private readonly processes = new Map<number, ReturnType<typeof Bun.spawn>>()
  private disposed = false
  constructor(options: z.input<typeof Options> = {}) { this.options = Options.parse(options) }
  async decode(input: Uint8Array, kind: ImageDecodeKind, frameIndex = 0, signal?: AbortSignal): Promise<ImageDecodeResult> {
    if (this.disposed) return { status: 'unavailable' }
    if (!['metadata', 'thumbnail', 'view'].includes(kind) || !Number.isSafeInteger(frameIndex) || frameIndex < 0) return { status: 'invalid' }
    if (input.byteLength > this.options.maxInputBytes) return { status: 'budget' }
    if (this.processes.size >= this.options.concurrency) return { status: 'busy' }
    if (signal?.aborted) return { status: 'unavailable' }
    const workerPath = this.options.workerPath ?? fileURLToPath(new URL('./image-preview-worker.ts', import.meta.url))
    const env: Record<string, string> = {}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]!
    const childEnv = buildNamespaceEnv({ ...env, BIOEVIDENCE_MODE: '1', BIOEVIDENCE_CONFIG_DIR: resolveConfigDir(), CRAFT_CONFIG_DIR: resolveConfigDir() })
    let child: ReturnType<typeof Bun.spawn> | undefined, timer: ReturnType<typeof setTimeout> | undefined, timedOut = false, aborted = false
    const stop = () => { try { child?.kill('SIGKILL') } catch { /* Already exited. */ } }
    const abort = () => { aborted = true; stop() }
    try {
      child = Bun.spawn([process.execPath, 'run', `--config=${resolve('scripts/bunfig.bio-bootstrap.toml')}`, workerPath], {
        cwd: resolveConfigDir(), env: childEnv, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
      })
      this.processes.set(child.pid, child)
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { timedOut = true; stop() }, this.options.timeoutMs)
      const output = (async () => {
        const chunks: Uint8Array[] = []; let size = 0
        const reader = (child!.stdout as ReadableStream<Uint8Array>).getReader()
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break
            size += value.length
            if (size > 20 * 1024 * 1024 + 2048) { stop(); throw Error('Bounded worker output exceeded') }
            chunks.push(value)
          }
          return Buffer.concat(chunks)
        } finally { reader.releaseLock() }
      })()
      void output.catch(() => {})
      const sink = child.stdin as Bun.FileSink
      sink.write(JSON.stringify({ kind, frameIndex, maxPixels: this.options.maxPixels, length: input.byteLength }) + '\n')
      sink.write(input); await sink.flush(); sink.end()
      const bytes = await output, exit = await child.exited
      if (timedOut) return { status: 'timeout' }
      if (aborted || exit !== 0) return { status: 'unavailable' }
      const split = bytes.indexOf(10)
      if (split < 0 || split > 2048) return { status: 'unavailable' }
      const raw = JSON.parse(bytes.subarray(0, split).toString('utf8')), info = ImageInfo.safeParse(raw)
      if (!info.success) {
        const failure = Failure.safeParse(raw)
        return failure.success && bytes.length === split + 1 ? failure.data : { status: 'unavailable' }
      }
      if (info.data.frameIndex !== frameIndex || info.data.width * info.data.height > this.options.maxPixels) return { status: 'unavailable' }
      if (kind === 'metadata') return bytes.length === split + 1 ? info.data : { status: 'unavailable' }
      const image = bytes.subarray(split + 1), edge = kind === 'thumbnail' ? 256 : 2048
      if (Math.max(info.data.width, info.data.height) > edge || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { status: 'unavailable' }
      return { ...info.data, bytes: image }
    } catch { return { status: timedOut ? 'timeout' : 'unavailable' } }
    finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (child) { stop(); await child.exited; this.processes.delete(child.pid) }
    }
  }
  get activeProcessIds(): number[] { return [...this.processes.keys()] }
  async close(): Promise<void> {
    this.disposed = true
    const children = [...this.processes.values()]
    for (const child of children) { try { child.kill('SIGKILL') } catch { /* Already exited. */ } }
    await Promise.all(children.map(child => child.exited))
    for (const child of children) this.processes.delete(child.pid)
  }
  get limits() { return { maxInputBytes: this.options.maxInputBytes, maxPixels: this.options.maxPixels, concurrency: this.options.concurrency, timeoutMs: this.options.timeoutMs } }
}
