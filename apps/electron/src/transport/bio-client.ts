import { ResearchError, ResearchEventSchema, ResearchRequestSchemas, parseResearchRequest, RESEARCH_CHANNELS,
  type PublicAccount, type DocumentIngestResult } from '@bio-evidence/research-core'
import { validatedAuthOrigin } from '@craft-agent/shared/auth/bio-client'
import type { BioClientState, BioPdfImport } from '../shared/bio-api'
export interface BioRpcTransport {
  connect(): void; destroy(): void
  invoke(channel: string, ...args: any[]): Promise<unknown>
  on(channel: string, callback: (event: unknown) => void): () => void
  onConnectionStateChanged(callback: (state: { status: string }) => void): () => void
}
export interface BioAuthorizedSession {
  account: PublicAccount; transport: BioRpcTransport
  current(): Promise<PublicAccount>
  close(revoke: boolean): Promise<void>
  importPdf(input: BioPdfImport, bytes: Uint8Array): Promise<DocumentIngestResult>
}
export interface BioAuthDriver {
  restore(origin: string): Promise<BioAuthorizedSession | null>
  login(origin: string, username: string, password: string): Promise<BioAuthorizedSession>
}
/** One per renderer window. Login queues prevent late cookie responses switching identity. */
export class BioClientController {
  private stateValue: BioClientState
  private session?: BioAuthorizedSession
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(state: BioClientState) => void>()
  private eventListeners = new Set<(event: unknown) => void>()
  private unsubscribers: (() => void)[] = []
  private restoring = false
  private closed = false
  private requestGeneration = 0
  constructor(private readonly driver: BioAuthDriver, origin: string) { this.stateValue = { origin: origin ? validatedAuthOrigin(origin) : '', account: null, status: 'signed-out', epoch: 0 } }
  get state(): BioClientState { return structuredClone(this.stateValue) }
  onState(callback: (state: BioClientState) => void) { this.listeners.add(callback); callback(this.state); return () => { this.listeners.delete(callback) } }
  on(channel: string, callback: (event: unknown) => void) {
    if (channel !== RESEARCH_CHANNELS.EVENT) throw new ResearchError('BIO_ACCESS_DENIED')
    this.eventListeners.add(callback); return () => { this.eventListeners.delete(callback) }
  }
  private emit(patch: Partial<BioClientState>) { this.stateValue = { ...this.stateValue, ...patch }; for (const cb of this.listeners) { try { cb(this.state) } catch {} } }
  private reset(origin = this.stateValue.origin) {
    this.requestGeneration++
    const old = this.session; this.session = undefined
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    old?.transport.destroy()
    this.emit({ origin, account: null, status: 'signed-out', errorCode: undefined, epoch: this.stateValue.epoch + 1, viewRevision: 0 })
    return old
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work); this.queue = result.catch(() => {}); return result
  }
  private bind(session: BioAuthorizedSession, epoch: number) {
    if (this.closed) { session.transport.destroy(); void session.close(false).catch(() => {}); return }
    this.session = session
    this.emit({ account: session.account, status: 'connecting', errorCode: undefined })
    this.unsubscribers.push(session.transport.onConnectionStateChanged(state => {
      if (epoch !== this.stateValue.epoch || this.session !== session) return
      const status = state.status === 'connected' ? 'connected' : state.status === 'connecting' ? 'connecting' : 'disconnected'
      if (status !== this.stateValue.status) this.requestGeneration++
      this.emit({ status })
    }), session.transport.on(RESEARCH_CHANNELS.EVENT, raw => {
      if (epoch !== this.stateValue.epoch || this.session !== session || this.stateValue.status !== 'connected') return
      const event = ResearchEventSchema.safeParse(raw)
      if (!event.success) return
      for (const cb of this.eventListeners) { try { cb(event.data) } catch {} }
    }))
    session.transport.connect()
  }
  async current(): Promise<BioClientState> {
    if (this.closed || !this.stateValue.origin) return this.state
    const requestedEpoch = this.stateValue.epoch
    return this.serialize(async () => {
      if (this.closed || requestedEpoch !== this.stateValue.epoch) return this.state
      const epoch = this.stateValue.epoch, session = this.session
      try {
        if (session) {
          const account = await session.current()
          if (epoch !== this.stateValue.epoch) return this.state
          if (account.id !== session.account.id) throw new ResearchError('BIO_ACCESS_DENIED')
          this.emit({ account })
        } else if (!this.restoring) {
          this.restoring = true
          const restored = await this.driver.restore(this.stateValue.origin)
          if (epoch !== this.stateValue.epoch) { restored?.transport.destroy(); await restored?.close(false); return this.state }
          if (restored) this.bind(restored, epoch)
        }
      } catch { if (epoch === this.stateValue.epoch) { this.reset(); this.emit({ errorCode: 'AUTH_FAILED' }) } }
      return this.state
    })
  }
  async login(origin: string, username: string, password: string): Promise<BioClientState> {
    if (this.closed) throw new ResearchError('BIO_ACCESS_DENIED')
    const base = validatedAuthOrigin(origin), old = this.reset(base), epoch = this.stateValue.epoch
    this.restoring = true; this.emit({ status: 'connecting' })
    return this.serialize(async () => {
      await old?.close(true).catch(() => {})
      if (epoch !== this.stateValue.epoch) return this.state
      try {
        const session = await this.driver.login(base, username, password)
        if (epoch !== this.stateValue.epoch) { session.transport.destroy(); await session.close(true).catch(() => {}); return this.state }
        this.bind(session, epoch)
      } catch { if (epoch === this.stateValue.epoch) this.emit({ account: null, status: 'error', errorCode: 'AUTH_FAILED' }) }
      return this.state
    })
  }
  async logout(): Promise<void> {
    const old = this.reset(); this.restoring = true
    await this.serialize(async () => { await old?.close(true).catch(() => {}) })
  }
  private active() {
    if (this.closed || !this.session || this.stateValue.status !== 'connected') throw new ResearchError('BIO_ACCESS_DENIED')
    return { session: this.session, epoch: this.stateValue.epoch, generation: this.requestGeneration }
  }
  private assertSame(session: BioAuthorizedSession, epoch: number, generation: number) {
    if (this.session !== session || this.stateValue.epoch !== epoch || this.requestGeneration !== generation || this.stateValue.status !== 'connected') throw new ResearchError('BIO_ACCESS_DENIED')
  }
  private denied(error: unknown, session: BioAuthorizedSession, epoch: number, generation: number) {
    if ((error as { code?: string })?.code !== 'BIO_ACCESS_DENIED' || this.session !== session || epoch !== this.stateValue.epoch || generation !== this.requestGeneration || this.closed) return
    this.requestGeneration++
    this.emit({ viewRevision: (this.stateValue.viewRevision ?? 0) + 1, errorCode: 'BIO_ACCESS_DENIED' })
  }
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!Object.hasOwn(ResearchRequestSchemas, channel) || args.length !== 1) throw new ResearchError('BIO_ACCESS_DENIED')
    const input = parseResearchRequest(channel, args[0]), { session, epoch, generation } = this.active()
    let result: unknown
    try { result = await session.transport.invoke(channel, input) } catch (error) { this.denied(error, session, epoch, generation); throw error }
    this.assertSame(session, epoch, generation)
    return result
  }
  async importPdf(input: BioPdfImport, bytes: Uint8Array): Promise<DocumentIngestResult> {
    const { session, epoch, generation } = this.active()
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 25 * 1024 * 1024) throw new ResearchError('BIO_INPUT_INVALID')
    let result: DocumentIngestResult
    try { result = await session.importPdf(input, bytes) } catch (error) { this.denied(error, session, epoch, generation); throw error }
    this.assertSame(session, epoch, generation); return result
  }
  dispose() { this.closed = true; const old = this.reset(); void old?.close(false).catch(() => {}); this.listeners.clear(); this.eventListeners.clear() }
}
