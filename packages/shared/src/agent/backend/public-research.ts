import { ResearchError } from '@bio-evidence/research-core'
import type { AgentEvent } from '@craft-agent/core/types'
import type { AgentBackend, BackendConfig, ChatOptions } from './types'
import type { FileAttachment } from '../../utils/files'
import type { ThinkingLevel } from '../thinking-levels'
import type { PermissionMode } from '../mode-manager'
export interface PublicResearchRuntime {
  readonly model: string; readonly connectionId: string; readonly approvedInput: string
  assertCurrent(): void
  stream(): AsyncGenerator<AgentEvent>
  abort(): Promise<void>
}
/** Adapter to the existing AgentBackend contract. Public work never enters BaseAgent helpers. */
export class PublicResearchBackend implements AgentBackend {
  private active = false; private consumed = false; private closed = false
  readonly supportsBranching = false
  constructor(private readonly runtime: PublicResearchRuntime) { runtime.assertCurrent() }
  async *chat(message: string, attachments?: FileAttachment[], options?: ChatOptions): AsyncGenerator<AgentEvent> {
    if (this.closed || this.consumed || this.active || message !== this.runtime.approvedInput || attachments?.length || options?.isRetry || options?.thinkingOverride) throw new ResearchError('BIO_POLICY_DENIED')
    this.runtime.assertCurrent(); this.active = true; this.consumed = true
    try { for await (const event of this.runtime.stream()) { this.runtime.assertCurrent(); yield event } }
    finally { this.active = false }
  }
  async abort() { await this.runtime.abort() }
  forceAbort() { void this.abort() }
  interruptForHandoff() { this.forceAbort() }
  redirect(_message: string): boolean { throw new ResearchError('BIO_POLICY_DENIED') }
  async runMiniCompletion(_prompt: string): Promise<string | null> { throw new ResearchError('BIO_POLICY_DENIED') }
  destroy() { this.closed = true; void this.abort() }
  dispose() { this.destroy() }
  async disposeForRestart() { this.closed = true; await this.abort() }
  async postInit() { this.runtime.assertCurrent(); return { authInjected: false } }
  async applyBridgeUpdates(): Promise<void> { throw new ResearchError('BIO_POLICY_DENIED') }
  async ensureBranchReady(): Promise<void> { throw new ResearchError('BIO_POLICY_DENIED') }
  isProcessing() { return this.active }
  getModel() { return this.runtime.model }
  setModel(model: string) { if (model !== this.runtime.model) throw new ResearchError('BIO_CONNECTION_INVALID') }
  getThinkingLevel(): ThinkingLevel { return 'off' }
  setThinkingLevel(_level: ThinkingLevel) { throw new ResearchError('BIO_POLICY_DENIED') }
  getPermissionMode(): PermissionMode { return 'safe' }
  setPermissionMode(_mode: PermissionMode) { /* Public tools have an immutable policy independent of UI mode. */ }
  cyclePermissionMode(): PermissionMode { return 'safe' }
  getSessionId(): string | null { return null }
  setSourceServers(mcp: Parameters<AgentBackend['setSourceServers']>[0], api: Record<string, unknown>, slugs?: string[]) {
    if (Object.keys(mcp).length || Object.keys(api).length || slugs?.length) throw new ResearchError('BIO_POLICY_DENIED')
  }
  getActiveSourceSlugs(): string[] { return [] }
  getCurrentTurnUserMessage(): string | null { return null }
  setPendingSourceActivationRestart(): void { throw new ResearchError('BIO_POLICY_DENIED') }
  getAllSources(): ReturnType<AgentBackend['getAllSources']> { return [] }
  setAllSources(sources: Parameters<AgentBackend['setAllSources']>[0]) { if (sources.length) throw new ResearchError('BIO_POLICY_DENIED') }
  markSourceUnseen(): void { throw new ResearchError('BIO_POLICY_DENIED') }
  getSummarizeCallback() { return (prompt: string) => this.runMiniCompletion(prompt) }
  updateWorkingDirectory(): void { throw new ResearchError('BIO_POLICY_DENIED') }
  updateSdkCwd(): void { throw new ResearchError('BIO_POLICY_DENIED') }
  setWorkspace(): void { throw new ResearchError('BIO_POLICY_DENIED') }
  setSessionId(): void { throw new ResearchError('BIO_POLICY_DENIED') }
  getSourceManager(): never { throw new ResearchError('BIO_POLICY_DENIED') }
  async generateTitle(): Promise<string | null> { return '公开文献调研' }
  async regenerateTitle(): Promise<string | null> { return '公开文献调研' }
  respondToPermission(): void { throw new ResearchError('BIO_POLICY_DENIED') }
  onPermissionRequest: AgentBackend['onPermissionRequest'] = null
  onPlanSubmitted: AgentBackend['onPlanSubmitted'] = null
  onAuthRequest: AgentBackend['onAuthRequest'] = null
  onSourceChange: AgentBackend['onSourceChange'] = null
  onPermissionModeChange: AgentBackend['onPermissionModeChange'] = null
  onDebug: AgentBackend['onDebug'] = null
  onSourceActivationRequest: AgentBackend['onSourceActivationRequest'] = null
  onBackendAuthRequired: AgentBackend['onBackendAuthRequired'] = null
  onSpawnSession: AgentBackend['onSpawnSession'] = null
}
export function createPublicResearchBackend(config: BackendConfig): AgentBackend {
  const runtime = config.publicResearchRuntime
  if (config.provider !== 'pi' || !runtime || !config.model || config.model !== runtime.model || config.connectionSlug !== runtime.connectionId) throw new ResearchError('BIO_CONNECTION_INVALID')
  return new PublicResearchBackend(runtime)
}
