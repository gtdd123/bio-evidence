import React, { useEffect, useState } from 'react'
import { z } from 'zod'
import { ReportContextSchema, ReportClaimSchema, renderReportMarkdown, CreateReportRequestSchema, SaveReportRequestSchema, type ReportView } from '@bio-evidence/research-core'
import type { SessionPanelProps } from './SessionDesk'
import { useBio, useBioT, useResource, useAction, useDraft, Button, Input, Textarea, Field, Check, ErrorNotice } from './ui'
import { ArtifactPicker, RevisionHistory, ArtifactStatus } from './ArtifactsUi'
export function ReportsPanel(props: SessionPanelProps & { onOpenEvidence(id: string): void; initialRevisionId?: string }) {
  const { host } = useBio(), t = useBioT(), [selected, setSelected] = useState(props.initialRevisionId ?? ''), [refresh, setRefresh] = useState(0)
  const view = useResource(() => selected ? host.research.getReport({ revisionId: selected }) : Promise.resolve(undefined), [selected, refresh])
  const changed = () => { setRefresh(value => value + 1); props.onChanged() }
  const reloadView = view.reload
  useEffect(() => host.research.onEvent(event => { if (event.sessionId === props.session.id && event.kind === 'report-changed') reloadView() }), [props.session.id, host.research, reloadView])
  return <div className="bio-panel"><ArtifactPicker kind="report" sessionId={props.session.id} selected={selected} onSelect={setSelected} refresh={refresh} /><ErrorNotice error={view.error} />
    {selected && !view.value ? <p>{t(view.loading ? 'loading' : 'accessLost')}</p> : <ReportEditor key={view.value?.revision.id ?? 'new'} {...props} view={view.value} onSaved={id => { setSelected(id); changed() }} />}
    {view.value && <><ArtifactStatus kind="report" view={view.value} writable={props.writable} onChanged={changed} /><RevisionHistory key={view.value.revision.reportId} kind="report" entityId={view.value.revision.reportId} onSelect={setSelected} /></>}
  </div>
}
const Draft = ReportContextSchema.extend({ title: z.string().max(300), markdown: z.string().max(1000000), declaredPublic: z.boolean(),
  claims: z.array(ReportClaimSchema.extend({ text: z.string().max(20000) })).max(1000) })
function ReportEditor({ session, writable, view, onSaved, onOpenEvidence }: SessionPanelProps & { view?: ReportView; onSaved(id: string): void; onOpenEvidence(id: string): void }) {
  const { host } = useBio(), t = useBioT(), action = useAction(), [cursor, setCursor] = useState<string>()
  const evidence = useResource(() => host.research.listArtifacts({ sessionId: session.id, pageSize: 100, ...(cursor ? { cursor } : {}) }), [session.id, cursor])
  const initial = { title: view?.revision.title ?? '', markdown: view?.revision.markdown ?? '', researchQuestion: view?.revision.researchQuestion ?? '', materialScope: view?.revision.materialScope ?? '',
    limitations: view?.revision.limitations ?? '', missingInformation: view?.revision.missingInformation ?? [], claims: view?.revision.claims ?? [], declaredPublic: false }
  const draft = useDraft([session.id, 'report', view?.revision.id ?? 'new'], JSON.stringify(initial))
  const parsed = Draft.safeParse(JSON.parse(draft.value)), value = parsed.success ? parsed.data : initial
  const edit = (patch: Partial<typeof initial>, regenerate = false) => { const next = { ...value, ...patch }; if (regenerate) next.markdown = renderReportMarkdown(next); draft.set(JSON.stringify(next)) }
  return <form className="bio-card bio-editor" onSubmit={event => { event.preventDefault(); void action.act(async () => {
    const evidenceRevisionIds = [...new Set(value.claims.flatMap(claim => claim.evidenceRevisionIds))]
    const { markdown, ...content } = value
    const saved = view ? await host.research.saveReport(SaveReportRequestSchema.parse({ ...value, evidenceRevisionIds, reportId: view.revision.reportId, expectedRevision: view.revision.revision }))
      : await host.research.createReport(CreateReportRequestSchema.parse({ ...content, sessionId: session.id }))
    draft.clear(); onSaved(saved.id)
  }) }}><h3>{t(view ? 'editReport' : 'newReport')}</h3><p className="bio-muted">{t('saveRevisionHelp')}</p>
    <Field label={t('title')}><Input aria-label={t('reportTitle')} value={value.title} maxLength={300} required disabled={!writable} onChange={event => edit({ title: event.target.value }, true)} /></Field>
    <Field label={t('researchQuestion')}><Textarea value={value.researchQuestion} maxLength={20000} disabled={!writable} onChange={event => edit({ researchQuestion: event.target.value })} /></Field>
    <Field label={t('materialScope')}><Textarea value={value.materialScope} maxLength={20000} disabled={!writable} onChange={event => edit({ materialScope: event.target.value })} /></Field>
    <Field label={t('limitations')}><Textarea value={value.limitations} maxLength={20000} disabled={!writable} onChange={event => edit({ limitations: event.target.value })} /></Field>
    <Field label={t('missingInformation')}><Textarea value={value.missingInformation.join('\n')} maxLength={20000} disabled={!writable} onChange={event => edit({ missingInformation: event.target.value.split('\n').filter(Boolean).slice(0, 50) })} /></Field>
    <h4>{t('mappedClaims')}</h4><p className="bio-muted">{t('mappedClaimsHelp')}</p><ErrorNotice error={evidence.error} />
    {value.claims.map((claim, index) => <section className="bio-card" key={claim.id}>
      <Field label={`${t('claim')} ${index + 1}`}><Textarea value={claim.text} maxLength={20000} disabled={!writable} onChange={event => edit({ claims: value.claims.map((item, i) => i === index ? { ...item, text: event.target.value } : item) }, true)} /></Field>
      <Check label={t('isInference')} checked={claim.isInference ?? false} disabled={!writable} onChange={isInference => edit({ claims: value.claims.map((item, i) => i === index ? { ...item, isInference } : item) }, true)} />
      {evidence.value?.items.filter(item => item.kind === 'evidence').map(item => <Check key={item.value.id} label={`v${item.value.revision} · ${item.value.title}`} checked={claim.evidenceRevisionIds.includes(item.value.id)} disabled={!writable} onChange={checked => edit({ claims: value.claims.map((entry, i) => i === index ? { ...entry, evidenceRevisionIds: checked ? [...entry.evidenceRevisionIds, item.value.id] : entry.evidenceRevisionIds.filter(id => id !== item.value.id) } : entry) }, true)} />)}
      <div className="bio-row">{claim.evidenceRevisionIds.map(id => <button type="button" className="bio-link" key={id} onClick={() => onOpenEvidence(id)}>{t('openEvidence')} · {id.slice(0, 8)}</button>)}</div>
      {writable && <Button type="button" variant="ghost" size="sm" onClick={() => edit({ claims: value.claims.filter((_, i) => i !== index) }, true)}>{t('removeClaim')}</Button>}
    </section>)}
    <div className="bio-row">{writable && <Button type="button" variant="outline" size="sm" disabled={value.claims.length >= 1000} onClick={() => edit({ claims: [...value.claims, { id: crypto.randomUUID(), text: '', evidenceRevisionIds: [], isInference: false }] }, true)}>{t('addClaim')}</Button>}
      {cursor && <Button type="button" variant="ghost" size="sm" onClick={() => setCursor(undefined)}>{t('firstPage')}</Button>}{evidence.value?.nextCursor && <Button type="button" variant="ghost" size="sm" onClick={() => setCursor(evidence.value?.nextCursor)}>{t('nextEvidencePage')}</Button>}</div>
    <Field label={t('reportMarkdown')}><Textarea aria-label={t('reportMarkdown')} className="bio-source-text" value={value.markdown} maxLength={1000000} disabled={!writable || !view} onChange={event => edit({ markdown: event.target.value })} /></Field><p className="bio-muted">{t('freeEditHelp')}</p>
    <Check label={t('declarePublicArtifact')} checked={value.declaredPublic} onChange={declaredPublic => edit({ declaredPublic })} disabled={!writable} />
    <ErrorNotice error={action.error || draft.error} /><Button disabled={!writable || action.busy || !value.title.trim()}>{t('saveNewRevision')}</Button>
  </form>
}
