import React, { useEffect, useState } from 'react'
import type { ResearchScope, ResearchSession } from '@bio-evidence/research-core'
import { sameScope } from '@bio-evidence/research-core'
import { useBio, useBioT, useResource, useDraft, Button, ErrorNotice, Tag, type SelectedQuote } from './ui'
import { PapersPanel } from './PapersPanel'
import { EvidencePanel } from './EvidencePanel'
import { ReportsPanel } from './ReportsPanel'
import { RunsPanel } from './RunsPanel'
export interface SessionPanelProps { session: ResearchSession; writable: boolean; onChanged(): void }
export function SessionDesk({ sessionId, scope, writable }: { sessionId: string; scope: ResearchScope; writable: boolean }) {
  const { host } = useBio(), t = useBioT(), [quotes, setQuotes] = useState<SelectedQuote[]>([])
  const navigation = useDraft([sessionId, 'navigation-research-tab'], 'papers'), tab = navigation.value, setTab = navigation.set
  const [evidenceRevision, setEvidenceRevision] = useState('')
  const [reportRevision, setReportRevision] = useState('')
  const session = useResource(async () => { const value = await host.research.getSession({ sessionId }); if (!sameScope(value.scope, scope)) throw { code: 'BIO_ACCESS_DENIED' }; return value }, [sessionId])
  const reloadSession = session.reload
  useEffect(() => host.research.onEvent(event => { if (event.sessionId === sessionId) reloadSession() }), [sessionId, host.research, reloadSession])
  if (!session.value) return <><ErrorNotice error={session.error} /><p className="bio-muted">{t(session.loading ? 'loading' : 'accessLost')}</p></>
  const props = { session: session.value, writable, onChanged: session.reload }
  return <section className="bio-session"><div className="bio-section-title"><h2>{session.value.name}</h2><Tag value={session.value.policy} /><span className="bio-muted">{t('revision')} {session.value.revision}</span></div>
    {session.value.policy !== 'public' && <p className="bio-warning">{t('privateCloudBlocked')}</p>}
    <nav className="bio-tabs" aria-label={t('research')}>
      {['papers', 'evidence', 'reports', 'runs'].map(value => <button key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}>{t(value)}</button>)}
    </nav>
    {tab === 'papers' ? <PapersPanel {...props} quotes={quotes} onQuotes={setQuotes} /> : tab === 'evidence' ? <EvidencePanel {...props} quotes={quotes} initialRevisionId={evidenceRevision} /> : tab === 'reports' ? <ReportsPanel {...props} initialRevisionId={reportRevision} onOpenEvidence={id => { setEvidenceRevision(id); setTab('evidence') }} /> : <RunsPanel {...props} quotes={quotes} onOpenArtifact={(kind, id) => { if (kind === 'evidence') setEvidenceRevision(id); else setReportRevision(id); setTab(kind === 'evidence' ? 'evidence' : 'reports') }} />}
    {quotes.length > 0 && <details className="bio-card bio-selected"><summary>{t('selectedExcerpts')} · {quotes.length}</summary>{quotes.map((quote, index) => <div key={`${quote.snapshotId}:${quote.blockId}:${quote.start}:${quote.end}`} className="bio-excerpt"><span>{quote.sourceTitle}</span><p>{quote.quote}</p><Button size="sm" variant="ghost" onClick={() => setQuotes(current => current.filter((_, i) => i !== index))}>{t('remove')}</Button></div>)}</details>}
  </section>
}
