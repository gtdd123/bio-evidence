import { BIO_ERROR_MESSAGES, RESEARCH_CHANNELS as R, ResearchError, ResearchEventSchema, ResearchRunPageSchema, ResearchRunViewSchema, IdSchema, parseContract,
  type ResearchRunView } from '@bio-evidence/research-core'
type RunPage = ReturnType<typeof ResearchRunPageSchema.parse>
interface RunTransport { invoke(channel: string, ...args: any[]): Promise<unknown>; on(channel: string, listener: (value: unknown) => void): () => void }
export interface ResearchRunClientState {
  status: 'idle' | 'loading' | 'ready' | 'disconnected' | 'denied' | 'error'
  page: RunPage; selected?: ResearchRunView; errorCode?: keyof typeof BIO_ERROR_MESSAGES
}
/** Shared renderer state. Events invalidate reads; they never act as persistence receipts. */
export class ResearchRunStateAdapter {
  private current: ResearchRunClientState = { status: 'idle', page: { items: [] } }
  private readonly unsubscribe: () => void
  private pending: Promise<void> | undefined
  private dirty = false
  private connected = true
  private closed = false
  private epoch = 0
  private sequence = 0
  private selectedId: string | undefined
  private cursor: string | undefined
  constructor(private readonly transport: RunTransport, readonly sessionId: string, private readonly changed?: (state: ResearchRunClientState) => void) {
    parseContract(IdSchema, sessionId)
    this.unsubscribe = transport.on(R.EVENT, raw => {
      const parsed = ResearchEventSchema.safeParse(raw)
      if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.kind !== 'run-changed' || parsed.data.sequence <= this.sequence) return
      this.sequence = parsed.data.sequence
      void this.refresh()
    })
  }
  get state(): ResearchRunClientState { return this.current }
  async refresh(): Promise<void> {
    if (!this.connected || this.closed) return
    this.dirty = true
    do {
      this.pending ??= Promise.resolve().then(() => this.read()).finally(() => { this.pending = undefined })
      await this.pending
    } while (this.dirty && this.connected && !this.closed)
  }
  async selectRun(id?: string): Promise<void> {
    if (id) parseContract(IdSchema, id)
    this.epoch++; this.selectedId = id; this.update({ ...this.current, selected: undefined })
    await this.refresh()
  }
  async pageAfter(cursor?: string): Promise<void> {
    if (cursor) parseContract(IdSchema, cursor)
    this.epoch++; this.cursor = cursor; await this.refresh()
  }
  async connectionChanged(connected: boolean): Promise<void> {
    this.epoch++; this.connected = connected; this.dirty = false
    this.update({ status: connected ? 'idle' : 'disconnected', page: { items: [] } })
    if (connected) await this.refresh()
  }
  close(): void {
    this.closed = true; this.epoch++; this.dirty = false; this.unsubscribe()
    this.update({ status: 'idle', page: { items: [] } })
  }
  private update(state: ResearchRunClientState) {
    this.current = state
    try { this.changed?.(state) } catch { /* A renderer callback cannot break authority refresh or trigger a resend. */ }
  }
  private bounded(raw: unknown): unknown {
    if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 2 * 1024 * 1024) throw new ResearchError('BIO_MODEL_BUDGET')
    return raw
  }
  private async read(): Promise<void> {
    while (this.dirty && this.connected && !this.closed) {
      this.dirty = false
      const epoch = this.epoch, selectedId = this.selectedId
      this.update({ ...this.current, status: 'loading', errorCode: undefined })
      try {
        const page = parseContract(ResearchRunPageSchema, this.bounded(await this.transport.invoke(R.LIST_RUNS, { sessionId: this.sessionId, pageSize: 20, ...(this.cursor ? { cursor: this.cursor } : {}) })))
        if (page.items.some(run => run.sessionId !== this.sessionId)) throw new ResearchError('BIO_ACCESS_DENIED')
        const selected = selectedId ? parseContract(ResearchRunViewSchema, this.bounded(await this.transport.invoke(R.GET_RUN, { runId: selectedId }))) : undefined
        if (selected && (selected.run.id !== selectedId || selected.run.sessionId !== this.sessionId)) throw new ResearchError('BIO_ACCESS_DENIED')
        if (epoch === this.epoch && this.connected && !this.closed) this.update({ status: 'ready', page, ...(selected ? { selected } : {}) })
      } catch (error) {
        if (epoch !== this.epoch || !this.connected || this.closed) continue
        const code = (error as { code?: string } | null)?.code
        const denied = code === 'BIO_ACCESS_DENIED' || code === 'AUTH_FAILED' || code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED'
        const errorCode = denied ? 'BIO_ACCESS_DENIED' : code && Object.hasOwn(BIO_ERROR_MESSAGES, code) ? code as keyof typeof BIO_ERROR_MESSAGES : 'BIO_STORAGE_UNAVAILABLE'
        this.update({ status: denied ? 'denied' : 'error', page: { items: [] }, errorCode })
      }
    }
  }
}
