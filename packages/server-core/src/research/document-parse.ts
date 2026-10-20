import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { buildNamespaceEnv } from '@craft-agent/shared/config/namespace.mjs'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace'
import { DocumentBudgetsSchema, ParsedDocumentResultSchema, SnapshotSchema, type ParsedDocumentResult } from '@bio-evidence/research-core'
const Options = DocumentBudgetsSchema.extend({ workerPath: z.string().optional() })
export class DocumentParseService {
  private readonly options: z.output<typeof Options>
  private readonly processes = new Map<number, ReturnType<typeof Bun.spawn>>()
  private closed = false
  constructor(options: z.input<typeof Options> = {}) { this.options = Options.parse(options) }
  get limits() { const { workerPath, ...budgets } = this.options; return budgets }
  get activeProcessIds(): number[] { return [...this.processes.keys()] }
  async parse(input: Uint8Array, format: 'pdf' | 'jats', signal?: AbortSignal): Promise<ParsedDocumentResult> {
    if (this.closed) return { status: 'unavailable' }
    if (!['pdf', 'jats'].includes(format) || !(input instanceof Uint8Array)) return { status: 'invalid' }
    if (input.length > (format === 'pdf' ? this.options.pdfMaxBytes : this.options.xmlMaxBytes)) return { status: 'budget' }
    if (this.processes.size) return { status: 'busy' }
    if (signal?.aborted) return { status: 'cancelled' }
    const worker = this.options.workerPath ?? fileURLToPath(new URL('./document-worker.ts', import.meta.url))
    const env: Record<string, string> = {}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]!
    const childEnv = buildNamespaceEnv({ ...env, BIOEVIDENCE_MODE: '1', BIOEVIDENCE_CONFIG_DIR: resolveConfigDir(), CRAFT_CONFIG_DIR: resolveConfigDir() })
    let child: ReturnType<typeof Bun.spawn> | undefined, timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false, cancelled = false, outputBudgetExceeded = false
    const kill = () => { try { child?.kill('SIGKILL') } catch {} }
    const abort = () => { cancelled = true; kill() }
    try {
      child = Bun.spawn([process.execPath, 'run', `--config=${resolve('scripts/bunfig.bio-bootstrap.toml')}`, worker], {
        cwd: resolveConfigDir(), env: childEnv, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
      })
      this.processes.set(child.pid, child); signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { timedOut = true; kill() }, this.options.timeoutMs)
      const output = (async () => {
        const reader = (child!.stdout as ReadableStream<Uint8Array>).getReader(), chunks: Uint8Array[] = []; let size = 0
        try {
          for (;;) {
            const item = await reader.read(); if (item.done) break
            size += item.value.length
            if (size > 64 * 1024 * 1024) { outputBudgetExceeded = true; kill(); throw Error('Parser output budget') }
            chunks.push(item.value)
          }
          return Buffer.concat(chunks)
        } finally { reader.releaseLock() }
      })()
      void output.catch(() => {})
      const sink = child.stdin as Bun.FileSink
      sink.write(JSON.stringify({ format, length: input.length, budgets: this.limits }) + '\n'); sink.write(input); await sink.flush(); sink.end()
      const bytes = await output, exit = await child.exited
      if (timedOut) return { status: 'timeout' }
      if (cancelled) return { status: 'cancelled' }
      if (exit !== 0) return { status: 'unavailable' }
      const parsed = ParsedDocumentResultSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      if (!parsed.success) return { status: 'unavailable' }
      if (parsed.data.status !== 'ok') return parsed.data
      const result = parsed.data
      const { status, ...content } = result
      if (result.format !== format || result.blocks.reduce((sum, block) => sum + block.text.length, 0) > this.options.maxTextChars ||
        format === 'pdf' && result.coverage.totalUnits > this.options.pdfMaxPages || !SnapshotSchema.safeParse({
          ...content, id: 'validation', sourceId: 'validation', scope: { kind: 'personal', ownerId: 'validation' }, policy: 'public',
          license: { status: 'unknown' }, acquiredBy: format === 'pdf' ? 'declared-public-pdf' : 'europe-pmc-oa', retrievedAt: 0, contentHash: '0'.repeat(64),
        }).success) return { status: 'unavailable' }
      return result
    } catch { return { status: timedOut ? 'timeout' : cancelled ? 'cancelled' : outputBudgetExceeded ? 'budget' : 'unavailable' } }
    finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (child) { kill(); await child.exited; this.processes.delete(child.pid) }
    }
  }
  async close(): Promise<void> {
    this.closed = true
    const children = [...this.processes.values()]
    for (const child of children) { try { child.kill('SIGKILL') } catch {} }
    await Promise.all(children.map(child => child.exited))
    for (const child of children) this.processes.delete(child.pid)
  }
}
