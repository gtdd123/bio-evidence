import { randomUUID } from 'node:crypto'
import { ResearchError, SessionSchema, SnapshotSchema, EvidenceRevisionSchema, IdSchema, RevisionSchema,
  parseContract, validateCitation, sameScope, mergePolicies, reviseEvidence, ReportRevisionSchema,
  renderReportMarkdown, ArtifactExportSchema, EvidenceViewSchema, ReportViewSchema, SourceSchema, EvidenceEditContentSchema, CreateEvidenceRequestSchema, SaveEvidenceRequestSchema, CreateReportRequestSchema, SaveReportRequestSchema,
  PublicCandidateResultSchema, type PublicCandidateResult,
  type Actor, type EvidenceRevision, type ReportRevision, type EvidenceView, type ReportView, type ArtifactExport } from '@bio-evidence/research-core'
import type { SqliteResearchRepository } from './sqlite-repository'
function markdownText(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#!|]/g, char => '\\' + char) }
function csvCell(value: string): string { const safe = /^[\s\uFEFF]*[=+@-]/.test(value) ? "'" + value : value; return '"' + safe.replace(/"/g, '""') + '"' }
class BoundedExport {
  private parts: string[] = []; private bytes = 0
  append(value: string) { if ((this.bytes += Buffer.byteLength(value)) > 8 * 1024 * 1024) throw new ResearchError('BIO_EXPORT_BUDGET'); this.parts.push(value) }
  text() { return this.parts.join('') }
}
export class ArtifactsService {
  constructor(private readonly repository: SqliteResearchRepository) {}
  createGeneratedCandidate(actor: Actor, sessionId: string, raw: PublicCandidateResult): EvidenceRevision | ReportRevision {
    const candidate = parseContract(PublicCandidateResultSchema, raw)
    return this.repository.artifactOperation(actor, 'session', sessionId, candidate.kind === 'evidence' ? 'evidence-create' : 'report-create', () =>
      candidate.kind === 'evidence' ? this.createEvidenceContent(actor, { ...candidate.content, sessionId, declaredPublic: true }, 'generated-public-context')
        : this.createReportContent(actor, { ...candidate.content, sessionId, declaredPublic: true }, 'generated-public-context'))
  }
  authorizeOperationRequest(actor: Actor, kind: 'session' | 'source' | 'evidence' | 'report', id: string, operation: Parameters<SqliteResearchRepository['artifactOperation']>[3]) {
    this.repository.artifactOperation(actor, kind, id, operation, () => undefined, 'request')
  }
  confirmSourceMetadata(actor: Actor, sourceId: string, expectedRevision: number) { return this.repository.artifactOperation(actor, 'source', sourceId, 'source-metadata-confirm', () => this.repository.confirmSourceMetadata(actor, sourceId, expectedRevision, Date.now())) }
  list(actor: Actor, sessionId: string, pageSize: number, cursor?: string) { return this.repository.listArtifactHeads(actor, sessionId, pageSize, cursor) }
  history(actor: Actor, kind: 'evidence' | 'report', entityId: string, pageSize: number, cursor?: string) { return this.repository.listArtifactRevisions(actor, kind, entityId, pageSize, cursor) }
  review(actor: Actor, input: { kind: 'evidence' | 'report'; revisionId: string; expectedRevision: number; decision: 'confirmed' | 'needs-changes' }) {
    return this.repository.artifactOperation(actor, input.kind, input.revisionId, 'artifact-review', () => this.reviewContent(actor, input))
  }
  private reviewContent(actor: Actor, input: { kind: 'evidence' | 'report'; revisionId: string; expectedRevision: number; decision: 'confirmed' | 'needs-changes' }) {
    const view = input.kind === 'evidence' ? this.evidenceView(actor, input.revisionId) : this.reportView(actor, input.revisionId)
    if (input.decision === 'confirmed' && view.unresolvedMetadataSourceIds.length) throw new ResearchError('BIO_INPUT_INVALID')
    return this.repository.reviewRevision(actor, input.kind, input.revisionId, input.expectedRevision, input.decision, Date.now())
  }
  evidenceView(actor: Actor, revisionId: string): EvidenceView {
    const revision = parseContract(EvidenceRevisionSchema, this.repository.get(actor, 'evidence', revisionId)), changes = new Map<string, EvidenceView['changedSources'][number]>()
    if (Buffer.byteLength(JSON.stringify(revision)) > 8 * 1024 * 1024) throw new ResearchError('BIO_EXPORT_BUDGET')
    const policies = [revision.policy ?? 'unknown']
    const unresolvedMetadataSourceIds = new Set<string>()
    for (const citation of revision.citations) {
      const snapshot = parseContract(SnapshotSchema, this.repository.get(actor, 'snapshot', citation.snapshotId)), current = this.repository.sourceHeadForRecord(actor, snapshot.sourceId)
      policies.push(snapshot.policy, current.policy)
      const source = parseContract(SourceSchema, this.repository.get(actor, 'source', snapshot.sourceId))
      for (const record of [source, current]) if (record.metadataConflictFields?.length && !record.metadataReview) unresolvedMetadataSourceIds.add(record.id)
      if (current.id !== snapshot.sourceId) changes.set(snapshot.id, { snapshotId: snapshot.id, sourceId: snapshot.sourceId, currentSourceId: current.id })
    }
    return parseContract(EvidenceViewSchema, { revision, effectivePolicy: mergePolicies(policies), changedSources: [...changes.values()], unresolvedMetadataSourceIds: [...unresolvedMetadataSourceIds] })
  }
  reportView(actor: Actor, revisionId: string): ReportView {
    const revision = parseContract(ReportRevisionSchema, this.repository.get(actor, 'report', revisionId)), changedSources = new Map<string, EvidenceView['changedSources'][number]>(), changedEvidenceRevisions: ReportView['changedEvidenceRevisions'] = []
    if (Buffer.byteLength(JSON.stringify(revision)) > 8 * 1024 * 1024) throw new ResearchError('BIO_EXPORT_BUDGET')
    const policies = [revision.policy ?? 'unknown']
    const unresolvedMetadataSourceIds = new Set<string>()
    let citations = 0, bytes = 0
    for (const id of revision.evidenceRevisionIds) {
      const item = parseContract(EvidenceRevisionSchema, this.repository.get(actor, 'evidence', id))
      citations += item.citations.length; bytes += Buffer.byteLength(JSON.stringify(item))
      if (citations > 10000 || bytes > 8 * 1024 * 1024) throw new ResearchError('BIO_EXPORT_BUDGET')
      const view = this.evidenceView(actor, id), current = parseContract(EvidenceRevisionSchema, this.repository.artifactHead(actor, 'evidence', view.revision.evidenceId))
      policies.push(view.effectivePolicy)
      for (const id of view.unresolvedMetadataSourceIds) unresolvedMetadataSourceIds.add(id)
      if (current.id !== id) changedEvidenceRevisions.push({ evidenceRevisionId: id, currentRevisionId: current.id })
      for (const source of view.changedSources) changedSources.set(source.snapshotId, source)
    }
    return parseContract(ReportViewSchema, { revision, effectivePolicy: mergePolicies(policies), changedSources: [...changedSources.values()], changedEvidenceRevisions, unresolvedMetadataSourceIds: [...unresolvedMetadataSourceIds] })
  }
  private reportDependencies(actor: Actor, scope: ReportRevision['scope'], ids: string[], declaredPublic: boolean) {
    const policies: string[] = [declaredPublic ? 'public' : 'restricted'], structuralStatuses: string[] = []; let count = 0, bytes = 0
    for (const id of ids) {
      const item = parseContract(EvidenceRevisionSchema, this.repository.get(actor, 'evidence', id))
      if (!sameScope(item.scope, scope)) throw new ResearchError('BIO_ACCESS_DENIED')
      count += item.citations.length; bytes += Buffer.byteLength(JSON.stringify(item))
      if (count > 10000 || bytes > 8 * 1024 * 1024) throw new ResearchError('BIO_EXPORT_BUDGET')
      const view = this.evidenceView(actor, item.id), policy = view.effectivePolicy
      if (declaredPublic && policy !== 'public') throw new ResearchError('BIO_POLICY_DENIED')
      policies.push(policy); structuralStatuses.push(view.unresolvedMetadataSourceIds.length ? 'pending' : item.structuralStatus)
    }
    return { policy: mergePolicies(policies), structuralStatuses }
  }
  createReport(actor: Actor, raw: unknown): ReportRevision {
    return this.repository.artifactOperation(actor, 'session', this.targetId(raw, 'sessionId'), 'report-create', () => this.createReportContent(actor, raw))
  }
  private createReportContent(actor: Actor, raw: unknown, declarationKind: 'explicit-public-edit' | 'generated-public-context' = 'explicit-public-edit'): ReportRevision {
    const input = parseContract(CreateReportRequestSchema, raw)
    if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new ResearchError('BIO_EXPORT_BUDGET')
    const session = parseContract(SessionSchema, this.repository.get(actor, 'session', input.sessionId))
    this.repository.authorizeScope(actor, session.scope, 'write')
    const evidenceRevisionIds = [...new Set(input.claims.flatMap(claim => claim.evidenceRevisionIds))], dependencies = this.reportDependencies(actor, session.scope, evidenceRevisionIds, input.declaredPublic), now = Date.now()
    const valid = input.claims.length > 0 && input.claims.every(claim => claim.evidenceRevisionIds.length > 0) && dependencies.structuralStatuses.every(status => status === 'structure-valid')
    const report = parseContract(ReportRevisionSchema, { id: randomUUID(), reportId: randomUUID(), sessionId: session.id, scope: session.scope, revision: 1, title: input.title,
      markdown: renderReportMarkdown(input), claims: input.claims, evidenceRevisionIds, structuralStatus: valid ? 'structure-valid' : 'pending', reviewStatus: 'unreviewed',
      researchQuestion: input.researchQuestion, materialScope: input.materialScope, limitations: input.limitations, missingInformation: input.missingInformation,
      policy: dependencies.policy, authorId: actor.userId, createdAt: now,
      ...(input.declaredPublic ? { declaration: { actorId: actor.userId, declaredAt: now, kind: declarationKind } } : {}) })
    return parseContract(ReportRevisionSchema, this.repository.commitArtifact(actor, 'report', report, 0))
  }
  saveReport(actor: Actor, raw: unknown): ReportRevision {
    return this.repository.artifactOperation(actor, 'report', this.targetId(raw, 'reportId'), 'report-save', () => this.saveReportContent(actor, raw))
  }
  private saveReportContent(actor: Actor, raw: unknown): ReportRevision {
    const input = parseContract(SaveReportRequestSchema, raw)
    if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new ResearchError('BIO_EXPORT_BUDGET')
    const previous = parseContract(ReportRevisionSchema, this.repository.artifactHead(actor, 'report', input.reportId))
    this.repository.authorizeScope(actor, previous.scope, 'write')
    if (previous.revision !== input.expectedRevision) throw new ResearchError('BIO_REVISION_CONFLICT')
    if (input.declaredPublic && previous.policy !== 'public') throw new ResearchError('BIO_POLICY_DENIED')
    const dependencies = this.reportDependencies(actor, previous.scope, input.evidenceRevisionIds, input.declaredPublic), now = Date.now()
    const valid = input.markdown === renderReportMarkdown(input) && input.claims.length > 0 && input.claims.every(claim => claim.evidenceRevisionIds.length > 0) && dependencies.structuralStatuses.every(status => status === 'structure-valid')
    const { review, declaration, ...old } = previous
    const report = parseContract(ReportRevisionSchema, { ...old, id: randomUUID(), revision: previous.revision + 1, title: input.title, markdown: input.markdown, claims: input.claims,
      evidenceRevisionIds: input.evidenceRevisionIds, structuralStatus: valid ? 'structure-valid' : 'pending', reviewStatus: 'unreviewed', authorId: actor.userId, createdAt: now,
      researchQuestion: input.researchQuestion, materialScope: input.materialScope, limitations: input.limitations, missingInformation: input.missingInformation,
      policy: mergePolicies([previous.policy ?? 'unknown', dependencies.policy]),
      ...(input.declaredPublic ? { declaration: { actorId: actor.userId, declaredAt: now, kind: 'explicit-public-edit' } } : {}) })
    return parseContract(ReportRevisionSchema, this.repository.commitArtifact(actor, 'report', report, input.expectedRevision))
  }
  private exported(value: ArtifactExport): ArtifactExport {
    if (Buffer.byteLength(value.content) > 8 * 1024 * 1024) throw new ResearchError('BIO_EXPORT_BUDGET')
    return parseContract(ArtifactExportSchema, value)
  }
  exportEvidence(actor: Actor, revisionId: string): ArtifactExport {
    return this.repository.artifactOperation(actor, 'evidence', revisionId, 'evidence-export', () => this.exportEvidenceContent(actor, revisionId))
  }
  private exportEvidenceContent(actor: Actor, revisionId: string): ArtifactExport {
    const { revision, changedSources, effectivePolicy } = this.evidenceView(actor, revisionId)
    const output = new BoundedExport(), row = (cells: string[]) => output.append(cells.map(csvCell).join(',') + '\r\n')
    row(['evidence_revision', 'claim', 'snapshot', 'block', 'start', 'end', 'quote', 'locator', 'structure', 'human_review', 'source_changed',
      'source_revision', 'source_identifiers', 'source_title', 'source_authors', 'source_year', 'snapshot_format', 'acquired_by', 'coverage_level', 'coverage_units', 'content_hash', 'retrieved_at', 'license', 'effective_policy', 'fact_summary', 'limitations', 'missing_information', 'structural_issues'])
    for (const citation of revision.citations) {
      const snapshot = parseContract(SnapshotSchema, this.repository.get(actor, 'snapshot', citation.snapshotId)), block = snapshot.blocks.find(item => item.id === citation.blockId), source = parseContract(SourceSchema, this.repository.get(actor, 'source', snapshot.sourceId))
      row([revision.id, revision.claim, citation.snapshotId, citation.blockId, String(citation.start), String(citation.end), citation.quote, JSON.stringify(block?.locator ?? null), revision.structuralStatus, revision.reviewStatus, String(changedSources.some(item => item.snapshotId === citation.snapshotId)),
        source.id, JSON.stringify(source.identifiers), source.title ?? '', JSON.stringify(source.authors ?? []), source.year === undefined ? '' : String(source.year), snapshot.format, snapshot.acquiredBy, snapshot.coverage.level, JSON.stringify(snapshot.coverage.units), snapshot.contentHash, String(snapshot.retrievedAt), JSON.stringify(snapshot.license), effectivePolicy,
        revision.factSummary ?? '', revision.limitations ?? '', JSON.stringify(revision.missingInformation ?? []), JSON.stringify(revision.structuralIssues ?? [])])
    }
    return this.exported({ format: 'csv', filename: `evidence-${revision.id}.csv`, mediaType: 'text/csv; charset=utf-8', content: output.text(), policy: effectivePolicy })
  }
  exportReport(actor: Actor, revisionId: string): ArtifactExport {
    return this.repository.artifactOperation(actor, 'report', revisionId, 'report-export', () => this.exportReportContent(actor, revisionId))
  }
  private exportReportContent(actor: Actor, revisionId: string): ArtifactExport {
    const view = this.reportView(actor, revisionId), revision = view.revision
    const output = new BoundedExport()
    output.append(`# ${markdownText(revision.title)}\n\n引用结构：${revision.structuralStatus}；人工核对：${revision.reviewStatus}\n\n结构校验不代表科学结论已证实。\n\n`)
    output.append(`## 研究问题与材料范围\n\n研究问题：${markdownText(revision.researchQuestion || '未提供（待补充）')}\n\n材料范围：${markdownText(revision.materialScope || '未提供（待补充）')}\n\n## 局限与缺失信息\n\n${markdownText(revision.limitations || '未提供（待补充）')}\n\n缺失信息：${markdownText((revision.missingInformation ?? []).join('；') || '未填写（不表示已完整）')}\n\n`)
    if (revision.structuralStatus === 'structure-valid') for (const claim of revision.claims) output.append(`${claim.isInference ? '（推断）' : ''}${markdownText(claim.text)}\n\n依据：${claim.evidenceRevisionIds.map(id => '`' + id + '`').join('、')}\n\n`)
    else output.append(markdownText(revision.markdown) + '\n\n')
    output.append('## 引用快照\n\n')
    for (const id of revision.evidenceRevisionIds) {
      const evidence = parseContract(EvidenceRevisionSchema, this.repository.get(actor, 'evidence', id))
      for (const ref of evidence.citations) {
        const snapshot = parseContract(SnapshotSchema, this.repository.get(actor, 'snapshot', ref.snapshotId)), block = snapshot.blocks.find(item => item.id === ref.blockId), source = parseContract(SourceSchema, this.repository.get(actor, 'source', snapshot.sourceId))
        output.append(`- 证据 \`${id}\`（结构${evidence.structuralStatus}；人工${evidence.reviewStatus}）；快照 \`${ref.snapshotId}\`；块 \`${ref.blockId}\`；UTF-16 ${ref.start}–${ref.end}；定位 ${markdownText(JSON.stringify(block?.locator ?? null))}\n\n  ${markdownText(ref.quote)}\n\n事实摘要：${markdownText(evidence.factSummary || '未提供（待补充）')}；局限：${markdownText(evidence.limitations || '未提供（待补充）')}；缺失信息：${markdownText((evidence.missingInformation ?? []).join('；') || '未填写（不表示已完整）')}\n\n`)
        output.append(`  来源修订：\`${source.id}\`；题录：${markdownText(source.title ?? '未取得题名')}；作者：${markdownText((source.authors ?? []).join('、'))}；年份：${source.year ?? '未取得'}；标识：${markdownText(JSON.stringify(source.identifiers))}\n\n`)
        output.append(`  格式：${snapshot.format}；取得方式：${snapshot.acquiredBy}；覆盖：${snapshot.coverage.level}（JATS为正文body文本）；单位：${markdownText(JSON.stringify(snapshot.coverage.units))}\n\n  指纹：\`${snapshot.contentHash}\`；取得时间：${snapshot.retrievedAt}；许可：${markdownText(JSON.stringify(snapshot.license))}\n\n`)
      }
    }
    output.append(`来源变化：${view.changedSources.length}；证据修订变化：${view.changedEvidenceRevisions.length}\n`)
    return this.exported({ format: 'markdown', filename: `report-${revision.id}.md`, mediaType: 'text/markdown; charset=utf-8', policy: view.effectivePolicy,
      content: output.text() })
  }
  private content(actor: Actor, scope: EvidenceRevision['scope'], input: unknown) {
    const content = parseContract(EvidenceEditContentSchema, input), structuralIssues = new Set<NonNullable<EvidenceRevision['structuralIssues']>[number]>()
    const policies: string[] = []
    for (const citation of content.citations) {
      const snapshot = parseContract(SnapshotSchema, this.repository.get(actor, 'snapshot', citation.snapshotId))
      if (!sameScope(snapshot.scope, scope)) throw new ResearchError('BIO_ACCESS_DENIED')
      const check = validateCitation(snapshot, citation)
      if (check.status !== 'structure-valid') structuralIssues.add(check.reason === 'block-missing' ? 'block-missing' : 'excerpt-mismatch')
      const source = parseContract(SourceSchema, this.repository.get(actor, 'source', snapshot.sourceId)), current = this.repository.sourceHeadForRecord(actor, source.id)
      if (source.metadataConflictFields?.length && !source.metadataReview || current.metadataConflictFields?.length && !current.metadataReview) structuralIssues.add('source-metadata-conflict')
      policies.push(snapshot.policy, current.policy)
    }
    if (content.declaredPublic && policies.some(policy => policy !== 'public')) throw new ResearchError('BIO_POLICY_DENIED')
    return { content, structuralIssues: [...structuralIssues], policy: mergePolicies([content.declaredPublic ? 'public' : 'restricted', ...policies]) }
  }
  createEvidence(actor: Actor, raw: unknown): EvidenceRevision {
    return this.repository.artifactOperation(actor, 'session', this.targetId(raw, 'sessionId'), 'evidence-create', () => this.createEvidenceContent(actor, raw))
  }
  private createEvidenceContent(actor: Actor, raw: unknown, declarationKind: 'explicit-public-edit' | 'generated-public-context' = 'explicit-public-edit'): EvidenceRevision {
    const { sessionId, ...body } = parseContract(CreateEvidenceRequestSchema, raw), session = parseContract(SessionSchema, this.repository.get(actor, 'session', sessionId))
    if (Buffer.byteLength(JSON.stringify(body)) > 8 * 1024 * 1024) throw new ResearchError('BIO_EXPORT_BUDGET')
    this.repository.authorizeScope(actor, session.scope, 'write')
    const { content, policy, structuralIssues } = this.content(actor, session.scope, body), now = Date.now()
    const evidence = parseContract(EvidenceRevisionSchema, { id: randomUUID(), evidenceId: randomUUID(), sessionId, scope: session.scope, revision: 1,
      claim: content.claim, citations: content.citations, factSummary: content.factSummary, limitations: content.limitations, missingInformation: content.missingInformation,
      policy, structuralIssues, structuralStatus: structuralIssues.length ? 'pending' : 'structure-valid', reviewStatus: 'unreviewed', authorId: actor.userId, createdAt: now,
      ...(content.declaredPublic ? { declaration: { actorId: actor.userId, declaredAt: now, kind: declarationKind } } : {}) })
    return parseContract(EvidenceRevisionSchema, this.repository.commitArtifact(actor, 'evidence', evidence, 0))
  }
  saveEvidence(actor: Actor, raw: unknown): EvidenceRevision {
    return this.repository.artifactOperation(actor, 'evidence', this.targetId(raw, 'evidenceId'), 'evidence-save', () => this.saveEvidenceContent(actor, raw))
  }
  private saveEvidenceContent(actor: Actor, raw: unknown): EvidenceRevision {
    const { evidenceId, expectedRevision, ...body } = parseContract(SaveEvidenceRequestSchema, raw)
    if (Buffer.byteLength(JSON.stringify(body)) > 8 * 1024 * 1024) throw new ResearchError('BIO_EXPORT_BUDGET')
    parseContract(RevisionSchema, expectedRevision)
    const previous = parseContract(EvidenceRevisionSchema, this.repository.artifactHead(actor, 'evidence', parseContract(IdSchema, evidenceId)))
    this.repository.authorizeScope(actor, previous.scope, 'write')
    const { content, policy, structuralIssues } = this.content(actor, previous.scope, body), now = Date.now()
    if (content.declaredPublic && previous.policy !== 'public') throw new ResearchError('BIO_POLICY_DENIED')
    const revision = reviseEvidence(previous, { claim: content.claim, citations: content.citations }, expectedRevision, randomUUID(), actor.userId, now)
    const { declaration, ...withoutDeclaration } = revision
    const next = parseContract(EvidenceRevisionSchema, { ...withoutDeclaration, policy: mergePolicies([previous.policy ?? 'unknown', policy]), structuralStatus: structuralIssues.length ? 'pending' : 'structure-valid', structuralIssues,
      factSummary: content.factSummary, limitations: content.limitations, missingInformation: content.missingInformation,
      ...(content.declaredPublic ? { declaration: { actorId: actor.userId, declaredAt: now, kind: 'explicit-public-edit' } } : {}) })
    return parseContract(EvidenceRevisionSchema, this.repository.commitArtifact(actor, 'evidence', next, expectedRevision))
  }
  private targetId(raw: unknown, key: string): string { return parseContract(IdSchema, raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined) }
}
