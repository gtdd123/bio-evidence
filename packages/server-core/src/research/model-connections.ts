import { randomUUID } from 'node:crypto'
import { ResearchError, SaveResearchConnectionSchema, ResearchConnectionRecordSchema, ResearchConnectionViewSchema, parseContract, IdSchema,
  ResearchConnectionConfigurationSchema, type ResearchConnectionConfiguration,
  type Actor, type ResearchScope, type ResearchConnectionRecord, type ResearchConnectionView } from '@bio-evidence/research-core'
import type { SqliteResearchRepository } from './sqlite-repository'
import { ResearchConnectionBroker } from './public-input'
interface KeyStore { getLlmApiKey(id: string): Promise<string | null>; setLlmApiKey(id: string, value: string): Promise<void>; deleteLlmApiKey(id: string): Promise<unknown> }
function deployment(record: ResearchConnectionRecord) { const { id, scope, policy, createdAt, updatedAt, ...configuration } = record; return configuration }
function view(record: ResearchConnectionRecord): ResearchConnectionView { return parseContract(ResearchConnectionViewSchema, { slug: record.slug, name: record.name, providerType: record.providerType, revision: record.revision,
  enabled: record.enabled, baseUrl: record.providerType === 'pi' ? 'https://api.openai.com/v1' : record.baseUrl, api: record.providerType === 'pi' ? 'openai-responses' : record.customEndpoint?.api, models: record.models, keyConfigured: !!record.credentialId }) }
export class ResearchConnectionsService {
  readonly broker: ResearchConnectionBroker
  constructor(private readonly repository: SqliteResearchRepository, private readonly keys: KeyStore, private readonly currentActor: (actor: Actor) => Actor = actor => actor) {
    this.broker = new ResearchConnectionBroker(repository, (actor, scope) => repository.researchConnectionsForScope(this.currentActor(actor), scope).map(deployment), id => keys.getLlmApiKey(id))
  }
  list(actor: Actor, scope: ResearchScope): ResearchConnectionView[] { return this.repository.researchConnectionsForScope(this.currentActor(actor), scope).filter(item => item.enabled).map(view) }
  authorizeSaveRequest(actor: Actor, id: string): void {
    try {
      actor = this.currentActor(actor)
      if (!this.repository.currentAccount(actor).administrator) throw new ResearchError('BIO_ACCESS_DENIED')
    } catch (error) {
      try { this.repository.recordConnectionSaveFailure(actor, id) } catch {}
      throw error
    }
  }
  configurationView(actor: Actor, id: string): ResearchConnectionView {
    const record = this.repository.managedResearchConnection(this.currentActor(actor), id)
    if (!record) throw new ResearchError('BIO_CONNECTION_INVALID')
    return view(record)
  }
  configuration(actor: Actor, id: string): ResearchConnectionConfiguration {
    const record = this.repository.managedResearchConnection(this.currentActor(actor), id)
    if (!record) throw new ResearchError('BIO_CONNECTION_INVALID')
    const { revision, credentialId, ...configuration } = deployment(record)
    return parseContract(ResearchConnectionConfigurationSchema, { configuration, revision, keyConfigured: !!credentialId })
  }
  async save(actor: Actor, raw: unknown): Promise<ResearchConnectionView> {
    const id = parseContract(IdSchema, raw && typeof raw === 'object' ? ((raw as Record<string, unknown>).configuration as Record<string, unknown> | undefined)?.slug : undefined)
    let staged: string | undefined, committed = false
    try {
      actor = this.currentActor(actor)
      if (!this.repository.currentAccount(actor).administrator) throw new ResearchError('BIO_ACCESS_DENIED')
      const input = parseContract(SaveResearchConnectionSchema, raw), configuration = input.configuration
      if (configuration.providerType === 'pi' ? configuration.piAuthProvider !== 'openai' || !!configuration.baseUrl || !!configuration.customEndpoint : !configuration.baseUrl || !configuration.customEndpoint || !!configuration.piAuthProvider) throw new ResearchError('BIO_CONNECTION_INVALID')
      if (configuration.baseUrl) { const url = new URL(configuration.baseUrl); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ResearchError('BIO_CONNECTION_INVALID') }
      if (new Set(configuration.models.map(model => model.id)).size !== configuration.models.length || configuration.models.some(model => model.maxOutputTokens >= model.contextWindow)) throw new ResearchError('BIO_CONNECTION_INVALID')
      const previous = this.repository.managedResearchConnection(actor, id)
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new ResearchError('BIO_REVISION_CONFLICT')
      let credentialId = previous?.credentialId
      if (input.apiKey) { staged = `bio-connection-${randomUUID()}`; await this.keys.setLlmApiKey(staged, input.apiKey); credentialId = staged }
      if (!credentialId) throw new ResearchError('BIO_CONNECTION_INVALID')
      actor = this.currentActor(actor)
      const now = Date.now(), record = parseContract(ResearchConnectionRecordSchema, { ...configuration, id, revision: input.expectedRevision + 1, credentialId, policy: 'restricted',
        scope: { kind: 'personal', ownerId: actor.userId }, createdAt: previous?.createdAt ?? now, updatedAt: now })
      const saved = this.repository.commitResearchConnection(actor, record, input.expectedRevision); committed = true
      return view(saved)
    } catch (error) {
      this.repository.recordConnectionSaveFailure(actor, id)
      if (error instanceof ResearchError) throw error
      throw new ResearchError('BIO_CONNECTION_INVALID')
    } finally {
      // A staged key is unique to this attempt. Never overwrite or delete an old active reference.
      if (staged && !committed) await this.keys.deleteLlmApiKey(staged).catch(() => {})
    }
  }
}
