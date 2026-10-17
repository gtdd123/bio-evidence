import React, { useEffect, useState } from 'react'
import { z } from 'zod'
import { EvidenceEditContentSchema, type Citation, type EvidenceView } from '@bio-evidence/research-core'
import type { SessionPanelProps } from './SessionDesk'
import { useBio, useBioT, useResource, useAction, useDraft, Button, Input, Textarea, Field, Check, ErrorNotice, LocatorLabel, type SelectedQuote } from './ui'
import { ArtifactPicker, RevisionHistory, ArtifactStatus, CitationInspector } from './ArtifactsUi'
export function EvidencePanel(props: SessionPanelProps & { quotes: SelectedQuote[]; initialRevisionId?: string }) {
  const { host } = useBio(), t = useBioT(), [selected, setSelected] = useState(props.initialRevisionId ?? ''), [refresh, setRefresh] = useState(0)
  const view = useResource(() => selected ? host.research.getEvidence({ revisionId: selected }) : Promise.resolve(undefined), [selected, refresh])
  const changed = () => { setRefresh(value => value + 1); props.onChanged() }
  const reloadView = view.reload
  useEffect(() => host.research.onEvent(event => { if (event.sessionId === props.session.id && event.kind === 'evidence-changed') reloadView() }), [props.session.id, host.research, reloadView])
  return <div className="bio-panel"><ArtifactPicker kind="evidence" sessionId={props.session.id} selected={selected} onSelect={setSelected} refresh={refresh} /><ErrorNotice error={view.error} />
    {selected && !view.value ? <p>{t(view.loading ? 'loading' : 'accessLost')}</p> : <EvidenceEditor key={view.value?.revision.id ?? 'new'} {...props} view={view.value} onSaved={id => { setSelected(id); changed() }} />}
    {view.value && <><ArtifactStatus kind="evidence" view={view.value} writable={props.writable} onChanged={changed} /><RevisionHistory key={view.value.revision.evidenceId} kind="evidence" entityId={view.value.revision.evidenceId} onSelect={setSelected} /></>}
  </div>
}
const Draft = EvidenceEditContentSchema.extend({ claim: z.string().max(20000), citations: z.array(EvidenceEditContentSchema.shape.citations.element).max(100) })
function EvidenceEditor({ session, writable, quotes, view, onSaved }: SessionPanelProps & { quotes: SelectedQuote[]; view?: EvidenceView; onSaved(id: string): void }) {
  const { host } = useBio(), t = useBioT(), action = useAction(), [inspect, setInspect] = useState<Citation>()
  const initial = { claim: view?.revision.claim ?? '', factSummary: view?.revision.factSummary ?? '', limitations: view?.revision.limitations ?? '', missingInformation: view?.revision.missingInformation ?? [], citations: view?.revision.citations ?? [], declaredPublic: false }
  const draft = useDraft([session.id, 'evidence', view?.revision.id ?? 'new'], JSON.stringify(initial))
  const parsed = Draft.safeParse(JSON.parse(draft.value)), value = parsed.success ? parsed.data : initial
  const edit = (patch: Partial<typeof initial>) => draft.set(JSON.stringify({ ...value, ...patch }))
  return <form className="bio-card bio-editor" onSubmit={event => { event.preventDefault(); void action.act(async () => {
    const content = EvidenceEditContentSchema.parse(value), saved = view ? await host.research.saveEvidence({ ...content, evidenceId: view.revision.evidenceId, expectedRevision: view.revision.revision }) : await host.research.createEvidence({ ...content, sessionId: session.id })
    draft.clear(); onSaved(saved.id)
  }) }}><h3>{t(view ? 'editEvidence' : 'newEvidence')}</h3><p className="bio-muted">{t('saveRevisionHelp')}</p>
    <Field label={t('claim')}><Textarea aria-label={t('claim')} value={value.claim} maxLength={20000} required disabled={!writable} onChange={event => edit({ claim: event.target.value })} /></Field>
    <Field label={t('factSummary')}><Textarea value={value.factSummary} maxLength={20000} disabled={!writable} onChange={event => edit({ factSummary: event.target.value })} /></Field>
    <Field label={t('limitations')}><Textarea value={value.limitations} maxLength={20000} disabled={!writable} onChange={event => edit({ limitations: event.target.value })} /></Field>
    <Field label={t('missingInformation')}><Textarea value={value.missingInformation.join('\n')} maxLength={20000} disabled={!writable} onChange={event => edit({ missingInformation: event.target.value.split('\n').filter(Boolean).slice(0, 50) })} /></Field>
    <div className="bio-section-title"><h4>{t('citations')}</h4><Button type="button" variant="outline" size="sm" disabled={!writable || !quotes.length} onClick={() => {
      const list = [...value.citations]
      for (const { sourceTitle, locator, policy, ...citation } of quotes) if (!list.some(item => JSON.stringify(item) === JSON.stringify(citation)) && list.length < 100) list.push(citation)
      edit({ citations: list })
    }}>{t('useSelectedExcerpts')}</Button></div>
    {value.citations.map((citation, index) => <div className="bio-excerpt" key={`${citation.snapshotId}:${citation.blockId}:${index}`}><button type="button" className="bio-link" onClick={() => setInspect(citation)}>{t('locate')} · {citation.blockId}</button><p>{citation.quote}</p>{writable && <Button type="button" size="sm" variant="ghost" onClick={() => edit({ citations: value.citations.filter((_, i) => i !== index) })}>{t('remove')}</Button>}</div>)}
    {inspect && <CitationInspector key={`${inspect.snapshotId}:${inspect.blockId}:${inspect.start}`} citation={inspect} />}
    <Check label={t('declarePublicArtifact')} checked={value.declaredPublic} onChange={value => edit({ declaredPublic: value })} disabled={!writable} />
    <ErrorNotice error={action.error || draft.error} /><Button disabled={!writable || action.busy || !value.claim.trim() || !value.citations.length} type="submit">{t('saveNewRevision')}</Button>
  </form>
}
