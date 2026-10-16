import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ResearchError, parseContract } from '@bio-evidence/research-core'
import { buildNamespaceEnv, resolveConfigDir, validateNamespacePath } from '@craft-agent/shared/config/namespace.mjs'
import { PublicPiStartSchema, PublicPiOutputSchema, type PublicModelAttempt } from './public-pi-protocol'
import type { PreparedPublicInput } from './public-input'
const Options = z.strictObject({ timeoutMs: z.number().int().min(100).max(180000).default(120000), workerPath: z.string().optional() })
export class PublicModelWorkerService {
  private readonly options: z.output<typeof Options>
  private readonly children = new Map<number, ReturnType<typeof Bun.spawn>>()
  private readonly pending = new Set<Promise<string>>()
  private closed = false
  constructor(options: z.input<typeof Options> = {}) { this.options = Options.parse(options) }
  get activeProcessIds(): number[] { return [...this.children.keys()] }
  async run(prepared: PreparedPublicInput, purpose: 'evidence' | 'report', apiKey: string, signal?: AbortSignal, mode: 'generate' | 'inspect' = 'generate', onAttempt?: (event: PublicModelAttempt) => Promise<void>): Promise<string> {
    const pending = this.runTask(prepared, purpose, apiKey, signal, mode, onAttempt); this.pending.add(pending)
    try { return await pending } finally { this.pending.delete(pending) }
  }
  private async runTask(prepared: PreparedPublicInput, purpose: 'evidence' | 'report', apiKey: string, signal?: AbortSignal, mode: 'generate' | 'inspect' = 'generate', onAttempt?: (event: PublicModelAttempt) => Promise<void>): Promise<string> {
    if (this.closed || signal?.aborted) throw new ResearchError('BIO_MODEL_CANCELLED')
    if (this.children.size) throw new ResearchError('BIO_MODEL_UNAVAILABLE')
    prepared.assertCurrent()
    const { api, baseUrl, model } = prepared.connection
    const start = parseContract(PublicPiStartSchema, { type: 'start', mode, job: { purpose, input: prepared.modelInput, apiKey, connection: { api, baseUrl, model } } })
    const parent = validateNamespacePath(join(resolveConfigDir(), 'public-runs')); mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, 'run-')), rootReal = realpathSync.native(root), parentReal = realpathSync.native(parent)
    const inside = (value: string) => { const offset = relative(parentReal, value); return !!offset && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset) }
    if (!inside(rootReal)) throw new ResearchError('BIO_ACCESS_DENIED')
    const allowed: Record<string, string> = {}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) allowed[key] = process.env[key]!
    const env = buildNamespaceEnv({ ...allowed, BIOEVIDENCE_MODE: '1', BIOEVIDENCE_CONFIG_DIR: rootReal, CRAFT_CONFIG_DIR: rootReal })
    let child: ReturnType<typeof Bun.spawn> | undefined, timer: ReturnType<typeof setTimeout> | undefined, timedOut = false
    const kill = () => { try { child?.kill('SIGKILL') } catch {} }
    try {
      child = Bun.spawn([process.execPath, 'run', `--config=${resolve('scripts/bunfig.bio-bootstrap.toml')}`, this.options.workerPath ?? fileURLToPath(new URL('./public-pi-worker.ts', import.meta.url))], {
        cwd: rootReal, env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
      })
      this.children.set(child.pid, child); timer = setTimeout(() => { timedOut = true; kill() }, this.options.timeoutMs); signal?.addEventListener('abort', kill, { once: true })
      const sink = child.stdin as Bun.FileSink
      sink.write(JSON.stringify(start) + '\n'); await sink.flush()
      let text: string | undefined, bytes = 0, count = 0, buffer = ''
      const decoder = new TextDecoder('utf-8', { fatal: true }), reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break
          bytes += chunk.value.length
          if (bytes > 2 * 1024 * 1024) throw new ResearchError('BIO_MODEL_BUDGET')
          buffer += decoder.decode(chunk.value, { stream: true })
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
            if (!line || ++count > 64 || text !== undefined) throw new ResearchError('BIO_MODEL_UNAVAILABLE')
            const frame = parseContract(PublicPiOutputSchema, JSON.parse(line))
            if (frame.type === 'error') throw new ResearchError(frame.code)
            prepared.assertCurrent()
            if (frame.type === 'check') {
              if (frame.kind === 'attempt') {
                if (!onAttempt) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
                await onAttempt(frame.attempt); prepared.assertCurrent()
              }
              sink.write(JSON.stringify({ type: 'allow', id: frame.id }) + '\n'); await sink.flush()
            }
            else text = frame.text
          }
        }
        buffer += decoder.decode()
        if (buffer.trim()) throw new ResearchError('BIO_MODEL_UNAVAILABLE')
      } finally { reader.releaseLock() }
      sink.end()
      const exit = await child.exited
      prepared.assertCurrent()
      if (exit !== 0 || !text || signal?.aborted || this.closed || text.includes(apiKey)) throw new ResearchError('BIO_MODEL_UNAVAILABLE')
      return text
    } catch (error) {
      if (signal?.aborted || this.closed) throw new ResearchError('BIO_MODEL_CANCELLED')
      if (timedOut) throw new ResearchError('BIO_MODEL_TIMEOUT')
      if (error instanceof ResearchError) throw error
      throw new ResearchError('BIO_MODEL_UNAVAILABLE')
    }
    finally {
      if (timer) clearTimeout(timer); signal?.removeEventListener('abort', kill)
      if (child) { kill(); await child.exited; this.children.delete(child.pid) }
      const finalRoot = realpathSync.native(root)
      if (finalRoot !== rootReal || !inside(finalRoot)) throw new ResearchError('BIO_ACCESS_DENIED')
      rmSync(finalRoot, { recursive: true, force: true })
    }
  }
  async close(): Promise<void> {
    this.closed = true; const children = [...this.children.values()]
    for (const child of children) { try { child.kill('SIGKILL') } catch {} }
    await Promise.all(children.map(child => child.exited))
    await Promise.allSettled([...this.pending])
    for (const child of children) this.children.delete(child.pid)
  }
}
