import React, { useEffect, useState } from 'react'
import type { Citation, EvidenceView, ReportView } from '@bio-evidence/research-core'
import { useBio, useBioT, useResource, useAction, Button, DataTable, Tag, ErrorNotice, LocatorLabel } from './ui'
export function ArtifactPicker({ kind, sessionId, selected, onSelect, refresh }: { kind: 'evidence' | 'report'; sessionId: string; selected: string; onSelect(id: string): void; refresh: number }) {
  const { host } = useBio(), t = useBioT(), [cursor, setCursor] = useState<string>()
  const page = useResource(() => host.research.listArtifacts({ sessionId, pageSize: 100, ...(cursor ? { cursor } : {}) }), [sessionId, cursor, refresh])
  const reloadPage = page.reload
  useEffect(() => host.research.onEvent(event => { if (event.sessionId === sessionId && (event.kind === `${kind}-changed` || event.kind === 'session-changed')) reloadPage() }), [sessionId, kind, host.research, reloadPage])
  const rows = page.value?.items.filter(item => item.kind === kind) ?? []
  return <section className="bio-artifact-list"><div className="bio-row"><Button size="sm" variant="outline" onClick={() => onSelect('')}>{t(kind === 'evidence' ? 'newEvidence' : 'newReport')}</Button><Button size="sm" variant="ghost" onClick={page.reload}>{t('refresh')}</Button></div><ErrorNotice error={page.error} />
    <DataTable data={rows} columns={[
      { id: 'title', header: t('title'), cell: ({ row }) => <button className="bio-link" aria-current={selected === row.original.value.id ? 'true' : undefined} onClick={() => onSelect(row.original.value.id)}>{row.original.value.title}</button> },
      { id: 'revision', header: t('revision'), cell: ({ row }) => row.original.value.revision },
      { id: 'status', header: t('status'), cell: ({ row }) => <div className="bio-row"><Tag value={row.original.value.structuralStatus} /><Tag value={row.original.value.reviewStatus} /></div> },
    ]} emptyContent={t(page.loading ? 'loading' : 'noArtifacts')} />
    <div className="bio-row">{cursor && <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>{t('firstPage')}</Button>}{page.value?.nextCursor && <Button variant="ghost" size="sm" onClick={() => setCursor(page.value?.nextCursor)}>{t('nextPage')}</Button>}</div>
  </section>
}
export function RevisionHistory({ kind, entityId, onSelect }: { kind: 'evidence' | 'report'; entityId: string; onSelect(id: string): void }) {
  const { host } = useBio(), t = useBioT(), [cursor, setCursor] = useState<string>()
  const page = useResource(() => host.research.listArtifactRevisions({ kind, entityId, pageSize: 20, ...(cursor ? { cursor } : {}) }), [kind, entityId, cursor])
  return <details className="bio-card"><summary>{t('revisionHistory')}</summary><ErrorNotice error={page.error} />{page.value?.items.map(item => <div className="bio-row" key={item.value.id}><button className="bio-link" onClick={() => onSelect(item.value.id)}>v{item.value.revision} · {item.value.title}</button><Tag value={item.value.reviewStatus} /></div>)}<div className="bio-row">{cursor && <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>{t('firstPage')}</Button>}{page.value?.nextCursor && <Button variant="ghost" size="sm" onClick={() => setCursor(page.value?.nextCursor)}>{t('nextPage')}</Button>}</div></details>
}
export function ArtifactStatus({ kind, view, writable, onChanged }: { kind: 'evidence' | 'report'; view: EvidenceView | ReportView; writable: boolean; onChanged(): void }) {
  const { host } = useBio(), t = useBioT(), action = useAction(), revision = view.revision
  const changedEvidence = 'changedEvidenceRevisions' in view ? view.changedEvidenceRevisions.length : 0
  return <div className="bio-card"><div className="bio-row"><Tag value={view.effectivePolicy} /><Tag value={revision.structuralStatus} /><Tag value={revision.reviewStatus} /><span>v{revision.revision}</span></div><p className="bio-muted">{t('reviewHelp')}</p>
    {(view.changedSources.length > 0 || changedEvidence > 0) && <p className="bio-warning">{t('dependenciesChanged')} · {view.changedSources.length} / {changedEvidence}</p>}
    {view.unresolvedMetadataSourceIds.length > 0 && <p className="bio-warning">{t('metadataConflict')} · {view.unresolvedMetadataSourceIds.length}</p>}
    {revision.review && <p className="bio-muted">{t('reviewer')}: {revision.review.reviewerId} · {new Date(revision.review.reviewedAt).toLocaleString()}</p>}
    <div className="bio-row">{writable && revision.reviewStatus === 'unreviewed' && <>
      <Button size="sm" variant="outline" disabled={action.busy || revision.structuralStatus !== 'structure-valid' || view.unresolvedMetadataSourceIds.length > 0} onClick={() => { void action.act(async () => { await host.research.reviewArtifact({ kind, revisionId: revision.id, expectedRevision: revision.revision, decision: 'confirmed' }); onChanged() }) }}>{t('confirmReview')}</Button>
      <Button size="sm" variant="outline" disabled={action.busy} onClick={() => { void action.act(async () => { await host.research.reviewArtifact({ kind, revisionId: revision.id, expectedRevision: revision.revision, decision: 'needs-changes' }); onChanged() }) }}>{t('needsChanges')}</Button>
    </>}
    <Button size="sm" variant="outline" disabled={action.busy} onClick={() => { void action.act(async () => { const value = kind === 'evidence' ? await host.research.exportEvidence({ revisionId: revision.id }) : await host.research.exportReport({ revisionId: revision.id }); await host.saveExport(value) }) }}>{t('export')}</Button></div><ErrorNotice error={action.error} />
  </div>
}
export function CitationInspector({ citation }: { citation: Citation }) {
  const { host } = useBio(), t = useBioT(), snapshot = useResource(() => host.research.getSnapshot({ snapshotId: citation.snapshotId }), [citation.snapshotId])
  const block = snapshot.value?.blocks.find(block => block.id === citation.blockId)
  const exact = block && block.text.slice(citation.start, citation.end) === citation.quote
  return <section className="bio-card"><h4>{t('citationLocation')}</h4><ErrorNotice error={snapshot.error} />{block && <><LocatorLabel locator={block.locator} /><p className="bio-muted">{t(`status.${snapshot.value!.coverage.level}`)} · UTF-16 {citation.start}–{citation.end}</p>{exact ? <p className="bio-source-text">{block.text.slice(0, citation.start)}<mark>{citation.quote}</mark>{block.text.slice(citation.end)}</p> : <p className="bio-error">{t('citationMismatch')}</p>}</>}</section>
}
