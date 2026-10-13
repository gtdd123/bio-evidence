import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import { open, opendir } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { ResearchError, parseContract, DeploymentGrantSchema, MaterialEntrySchema, MaterialBudgetsSchema, type Actor, type DeploymentGrant, type MaterialRoot,
  type MaterialPage, type MaterialGrantView, type ResearchScope, sameScope, type MaterialSearchResult, type ResearchRepository, type StoredDeploymentGrant, type MaterialDirectoryState, type IndexedMaterialEntry } from '@bio-evidence/research-core'
import { checkedGrantRoot, checkedMaterialPath, materialRelativePath, fileSignature, naturalMaterialKey, inside } from './material-paths'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const Cursor = z.strictObject({ rootId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), key: z.string().regex(/^[a-f0-9]{64}$/), generation: z.number().int().positive(), sort: z.string().max(4096), id: z.string().regex(/^[a-f0-9]{64}$/) })
interface MaterialOperations {
  openFile?: typeof open
  currentActor?: (actor: Actor) => Actor
  budgets?: z.input<typeof MaterialBudgetsSchema>
  now?: () => number
}
export class MaterialsService {
  private readonly grants = new Map<string, StoredDeploymentGrant>()
  private readonly indexing = new Map<string, Promise<void>>()
  private activeScan = false
  private readonly budgets: z.output<typeof MaterialBudgetsSchema>
  private readonly now: () => number
  constructor(private readonly repository: ResearchRepository, grants: readonly DeploymentGrant[], private readonly operations: MaterialOperations = {}) {
    this.budgets = parseContract(MaterialBudgetsSchema, operations.budgets ?? {})
    this.now = operations.now ?? Date.now
    const records = parseContract(z.array(DeploymentGrantSchema).max(1000), grants).map(grant => ({ ...grant, rootPath: checkedGrantRoot(grant.rootPath),
      authorityHash: hash(JSON.stringify(grant)), active: true }))
    for (let a = 0; a < records.length; a++) for (let b = a + 1; b < records.length; b++) {
      const left = records[a]!, right = records[b]!
      // Equal roots explicitly granted to two scopes are permitted. A wider
      // root must never accidentally expose another scope's narrower grant.
      if (!sameScope(left.scope, right.scope) && left.rootPath !== right.rootPath && (inside(left.rootPath, right.rootPath) || inside(right.rootPath, left.rootPath))) throw new ResearchError('BIO_ACCESS_DENIED')
    }
    this.repository.installDeploymentGrants(records)
    for (const record of records) this.grants.set(record.id, record)
  }
  private grant(actor: Actor, grantId: string, manage = false): StoredDeploymentGrant {
    actor = this.operations.currentActor?.(actor) ?? actor
    const configured = this.grants.get(grantId), stored = this.repository.materialGrant(actor, grantId, manage)
    if (!configured || stored.authorityHash !== configured.authorityHash) throw new ResearchError('BIO_ACCESS_DENIED')
    return configured
  }
  listGrants(actor: Actor, scope: ResearchScope): MaterialGrantView[] {
    actor = this.operations.currentActor?.(actor) ?? actor
    this.repository.authorizeScope(actor, scope, 'read')
    return [...this.grants.values()].filter(grant => sameScope(grant.scope, scope)).map(grant => {
      this.grant(actor, grant.id)
      return { id: grant.id, scope: grant.scope, label: grant.label }
    })
  }
  getRoot(actor: Actor, rootId: string): MaterialRoot {
    const root = this.repository.materialRoot(actor, rootId); this.grant(actor, root.grantId); return root
  }
  listRoots(actor: Actor, scope: ResearchScope, pageSize: number, cursor?: string) {
    actor = this.operations.currentActor?.(actor) ?? actor
    const page = this.repository.listMaterialRoots(actor, scope, pageSize, cursor)
    for (const root of page.items) this.grant(actor, root.grantId)
    return page
  }
  directoryGeneration(actor: Actor, rootId: string, relativeDir: string): number {
    const directory = this.directory(actor, rootId, relativeDir)
    return this.repository.materialDirectory(actor, rootId, directory.key).generation
  }
  indexState(actor: Actor, rootId: string, relativeDir: string): MaterialDirectoryState {
    const root = this.repository.materialRoot(actor, rootId); this.grant(actor, root.grantId)
    const key = hash(`${rootId}\0${materialRelativePath(relativeDir)}`), state = this.repository.materialDirectory(actor, rootId, key)
    return state.status === 'indexing' && !this.indexing.has(key) ? { ...state, status: 'failed', reason: 'interrupted' } : state
  }
  annotation(actor: Actor, rootId: string, relativeDir: string, generation: number, fileId: string) {
    const root = this.getRoot(actor, rootId), key = hash(`${root.id}\0${materialRelativePath(relativeDir)}`)
    return this.repository.materialAnnotation(actor, rootId, key, generation, fileId)
  }
  saveAnnotation(actor: Actor, rootId: string, relativeDir: string, generation: number, fileId: string, expectedRevision: number, note: string, tags: string[]) {
    const root = this.getRoot(actor, rootId), key = hash(`${root.id}\0${materialRelativePath(relativeDir)}`)
    return this.repository.saveMaterialAnnotation(actor, rootId, key, generation, { fileId, revision: expectedRevision + 1, note, tags, policy: 'restricted' }, expectedRevision)
  }
  validateSearchResult(actor: Actor, rootId: string, result: MaterialSearchResult): void {
    const directory = this.directory(actor, rootId, ''), state = this.repository.materialDirectory(actor, rootId, directory.key)
    if (state.status !== 'complete' || state.generation !== result.generation || state.signature !== fileSignature(directory.path)) throw new ResearchError('BIO_REVISION_CONFLICT')
    for (const match of result.matches) {
      const entry = this.repository.materialEntry(actor, rootId, directory.key, state.generation, match.fileId)
      const path = checkedMaterialPath(directory.grant.rootPath, [directory.root.relativeDir, entry.relativePath].filter(Boolean).join('/'))
      if (entry.name !== match.name || entry.signature !== fileSignature(path)) throw new ResearchError('BIO_REVISION_CONFLICT')
    }
  }
  registerRoot(actor: Actor, grantId: string, input: string): MaterialRoot {
    const grant = this.grant(actor, grantId, true), relativeDir = materialRelativePath(input)
    const path = checkedMaterialPath(grant.rootPath, relativeDir)
    if (!lstatSync(path).isDirectory()) throw new ResearchError('BIO_INPUT_INVALID')
    return this.repository.createMaterialRoot(actor, { id: randomUUID(), scope: grant.scope, grantId, relativeDir,
      label: relativeDir ? basename(path) : grant.label, policy: 'restricted' })
  }
  private directory(actor: Actor, rootId: string, input: string) {
    const root = this.repository.materialRoot(actor, rootId), grant = this.grant(actor, root.grantId)
    const relativeDir = materialRelativePath(input), suffix = [root.relativeDir, relativeDir].filter(Boolean).join('/')
    const path = checkedMaterialPath(grant.rootPath, suffix)
    if (!lstatSync(path).isDirectory()) throw new ResearchError('BIO_INPUT_INVALID')
    return { root, grant, relativeDir, suffix, path, key: hash(`${rootId}\0${relativeDir}`) }
  }
  async indexDirectory(actor: Actor, rootId: string, relativeDir = ''): Promise<void> {
    const directory = this.directory(actor, rootId, relativeDir), existing = this.indexing.get(directory.key)
    if (existing) { await existing; this.directory(actor, rootId, relativeDir); return }
    if (this.activeScan) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
    this.activeScan = true
    const work = this.scan(actor, directory).finally(() => { this.indexing.delete(directory.key); this.activeScan = false })
    this.indexing.set(directory.key, work); await work
  }
  private async scan(actor: Actor, directory: ReturnType<MaterialsService['directory']>): Promise<void> {
    let generation = 1
    try { generation = this.repository.materialDirectory(actor, directory.root.id, directory.key).generation + 1 } catch (error) {
      if (!(error instanceof ResearchError) || error.code !== 'BIO_REVISION_CONFLICT') throw error
    }
    const signature = fileSignature(directory.path), started = this.now()
    const state: MaterialDirectoryState = { key: directory.key, relativeDir: directory.relativeDir, generation, status: 'indexing', signature, count: 0 }
    this.repository.beginMaterialDirectory(actor, directory.root.id, state)
    try {
      const handle = await opendir(directory.path)
      let batch: IndexedMaterialEntry[] = []
      for await (const entry of handle) {
        if (this.now() - started > this.budgets.scanMs || state.count >= this.budgets.maxEntries) {
          state.reason = 'budget'; throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
        }
        const relativePath = [directory.relativeDir, entry.name].filter(Boolean).join('/')
        // Disallowed or linked entries are omitted without reading their contents.
        try {
          const suffix = [directory.root.relativeDir, relativePath].filter(Boolean).join('/')
          const path = checkedMaterialPath(directory.grant.rootPath, suffix), info = lstatSync(path)
          if (!info.isDirectory() && !info.isFile()) continue
          batch.push({ id: hash(`${directory.root.id}\0${relativePath}`), name: entry.name, relativePath,
            kind: info.isDirectory() ? 'directory' : 'file', size: info.size, modifiedAt: Math.max(0, Math.floor(info.mtimeMs)),
            policy: 'restricted', directoryKey: directory.key, sortKey: naturalMaterialKey(entry.name), signature: fileSignature(path) })
          state.count++
        } catch (error) { if (!(error instanceof ResearchError) || error.code !== 'BIO_ACCESS_DENIED') throw error }
        if (batch.length === 200) {
          this.directory(actor, directory.root.id, directory.relativeDir)
          this.repository.writeMaterialIndex(actor, directory.root.id, state, batch); batch = []
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
      this.directory(actor, directory.root.id, directory.relativeDir)
      if (fileSignature(directory.path) !== signature) throw new ResearchError('BIO_REVISION_CONFLICT')
      if (batch.length) this.repository.writeMaterialIndex(actor, directory.root.id, state, batch)
      this.repository.completeMaterialDirectory(actor, directory.root.id, { ...state, status: 'complete' })
    } catch (error) {
      try {
        this.repository.completeMaterialDirectory(actor, directory.root.id, { ...state, status: 'failed', reason: state.reason ??
          (error instanceof ResearchError && error.code === 'BIO_REVISION_CONFLICT' ? 'changed' : 'offline') })
      } catch { /* Lost authority or a newer generation must not be overwritten. */ }
      throw error instanceof ResearchError ? error : new ResearchError('BIO_STORAGE_UNAVAILABLE')
    }
  }
  list(actor: Actor, rootId: string, relativeDir = '', pageSize = 100, cursor?: string): MaterialPage {
    parseContract(z.number().int().min(1).max(200), pageSize)
    const directory = this.directory(actor, rootId, relativeDir), state = this.repository.materialDirectory(actor, rootId, directory.key)
    if (state.status !== 'complete' || state.signature !== fileSignature(directory.path)) throw new ResearchError('BIO_REVISION_CONFLICT')
    let afterSort = '', afterId = ''
    if (cursor) {
      if (cursor.length > 8192) throw new ResearchError('BIO_INPUT_INVALID')
      let value: z.infer<typeof Cursor>
      try { value = parseContract(Cursor, JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))) } catch { throw new ResearchError('BIO_INPUT_INVALID') }
      if (value.rootId !== rootId || value.key !== state.key || value.generation !== state.generation) throw new ResearchError('BIO_REVISION_CONFLICT')
      afterSort = value.sort; afterId = value.id
    }
    const entries = this.repository.materialEntries(actor, rootId, state.key, state.generation, afterSort, afterId, pageSize + 1)
    for (const entry of entries) {
      const path = checkedMaterialPath(directory.grant.rootPath, [directory.root.relativeDir, entry.relativePath].filter(Boolean).join('/'))
      if (fileSignature(path) !== entry.signature) throw new ResearchError('BIO_REVISION_CONFLICT')
    }
    const page = entries.slice(0, pageSize), last = page.at(-1)
    return { items: page.map(entry => MaterialEntrySchema.parse({ id: entry.id, name: entry.name, relativePath: entry.relativePath,
      kind: entry.kind, size: entry.size, modifiedAt: entry.modifiedAt, policy: 'restricted' })), generation: state.generation,
      ...(entries.length > pageSize && last ? { nextCursor: Buffer.from(JSON.stringify({ rootId, key: state.key, generation: state.generation, sort: last.sortKey, id: last.id })).toString('base64url') } : {}) }
  }
  async searchText(actor: Actor, rootId: string, query: string): Promise<MaterialSearchResult> {
    query = parseContract(z.string().trim().min(1).max(200), query)
    const directory = this.directory(actor, rootId, ''), matches: Array<{ fileId: string; name: string; snippet: string }> = []
    const initial = this.repository.materialDirectory(actor, rootId, directory.key)
    const skipped = { oversize: 0, unsupported: 0, invalidEncoding: 0 }
    const started = this.now(); let readBytes = 0, readFiles = 0, cursor: string | undefined
    const result = (truncated: boolean): MaterialSearchResult => {
      this.directory(actor, rootId, '')
      const final = this.repository.materialDirectory(actor, rootId, directory.key)
      if (final.status !== 'complete' || final.generation !== initial.generation || final.signature !== fileSignature(directory.path)) throw new ResearchError('BIO_REVISION_CONFLICT')
      const value: MaterialSearchResult = { matches, truncated, generation: initial.generation, filesRead: readFiles, bytesRead: readBytes, policy: 'restricted', skipped }
      this.validateSearchResult(actor, rootId, value); return value
    }
    do {
      if (this.now() - started > this.budgets.searchMs) return result(true)
      const page = this.list(actor, rootId, '', 200, cursor)
      for (const entry of page.items) {
        if (this.now() - started > this.budgets.searchMs || matches.length >= 64) return result(true)
        if (entry.name.toLowerCase().includes(query.toLowerCase())) {
          matches.push({ fileId: entry.id, name: entry.name, snippet: entry.name }); continue
        }
        const annotation = this.repository.materialAnnotation(actor, rootId, directory.key, initial.generation, entry.id)
        const annotated = [annotation.note, ...annotation.tags].join('\n'), noteOffset = annotated.toLowerCase().indexOf(query.toLowerCase())
        if (noteOffset >= 0) { matches.push({ fileId: entry.id, name: entry.name, snippet: annotated.slice(Math.max(0, noteOffset - 80), noteOffset + query.length + 120) }); continue }
        if (entry.kind !== 'file') continue
        if (!['.txt', '.md', '.csv', '.tsv', '.json'].includes(extname(entry.name).toLowerCase())) { skipped.unsupported++; continue }
        if (entry.size > this.budgets.textFileBytes) { skipped.oversize++; continue }
        if (readFiles >= this.budgets.textFiles || readBytes + entry.size > this.budgets.textTotalBytes) return result(true)
        // A page may survive asynchronous reads; use the signature from the
        // completed index, never promote the current disk object to authority.
        const bound = this.repository.materialEntry(actor, rootId, directory.key, initial.generation, entry.id)
        const path = checkedMaterialPath(directory.grant.rootPath, [directory.root.relativeDir, entry.relativePath].filter(Boolean).join('/'))
        const signature = fileSignature(path), before = lstatSync(path, { bigint: true })
        if (!bound || bound.signature !== signature) throw new ResearchError('BIO_REVISION_CONFLICT')
        const file = await (this.operations.openFile ?? open)(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
        try {
          const opened = await file.stat({ bigint: true })
          if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new ResearchError('BIO_REVISION_CONFLICT')
          if (opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) throw new ResearchError('BIO_REVISION_CONFLICT')
          checkedMaterialPath(directory.grant.rootPath, [directory.root.relativeDir, entry.relativePath].filter(Boolean).join('/'))
          this.directory(actor, rootId, '')
          if (this.now() - started > this.budgets.searchMs) return result(true)
          const data = Buffer.alloc(this.budgets.textFileBytes + 1), { bytesRead } = await file.read(data, 0, data.length, 0)
          const after = await file.stat({ bigint: true })
          if (bytesRead > this.budgets.textFileBytes || BigInt(bytesRead) !== opened.size || fileSignature(path) !== signature ||
            after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw new ResearchError('BIO_REVISION_CONFLICT')
          this.directory(actor, rootId, '')
          readFiles++; readBytes += bytesRead
          if (this.now() - started > this.budgets.searchMs) return result(true)
          let text: string
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytesRead)) } catch { skipped.invalidEncoding++; continue }
          const offset = text.toLowerCase().indexOf(query.toLowerCase())
          if (offset >= 0) matches.push({ fileId: entry.id, name: entry.name, snippet: text.slice(Math.max(0, offset - 80), offset + query.length + 120) })
        } finally { await file.close() }
      }
      cursor = page.nextCursor
    } while (cursor)
    return result(false)
  }
}
