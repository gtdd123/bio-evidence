import React, { useState } from 'react'
import type { LiteratureSearchPage, ResearchSource, ReadingSnapshot } from '@bio-evidence/research-core'
import type { SessionPanelProps } from './SessionDesk'
import { bioCapabilities } from './capabilities'
import { useBio, useBioT, useResource, useAction, useDraft, Button, Input, Textarea, Field, Check, Tag, ErrorNotice, LocatorLabel, type SelectedQuote } from './ui'
export function PapersPanel({ session, writable, onChanged, quotes, onQuotes }: SessionPanelProps & { quotes: SelectedQuote[]; onQuotes(value: SelectedQuote[]): void }) {
  const { host, account } = useBio(), t = useBioT(), action = useAction(), query = useDraft([session.id, 'literature-query'], '')
  const executable = bioCapabilities(writable ? 'editor' : 'viewer', account.id, session.ownerId).executeSession
  const [results, setResults] = useState<LiteratureSearchPage>(), [submitted, setSubmitted] = useState(''), [publicPdf, setPublicPdf] = useState(false), [status, setStatus] = useState('')
  const [sourceId, setSourceId] = useState(session.selectedSourceIds?.[0] ?? ''), [sourcePage, setSourcePage] = useState(0)
  const ids = (session.selectedSourceIds ?? []).slice(sourcePage * 50, (sourcePage + 1) * 50)
  const sources = useResource(() => Promise.all(ids.map(sourceId => host.research.getSource({ sourceId }))), [ids.join(',')])
  const search = (cursor?: string) => action.act(async () => { const value = await host.research.search({ sessionId: session.id, query: cursor ? submitted : query.value, pageSize: 25, ...(cursor ? { cursor } : {}) }); setSubmitted(cursor ? submitted : query.value); setResults(value) })
  return <div className="bio-panel"><div className="bio-two-columns"><section>
    <div className="bio-section-title"><h3>{t('literatureSearch')}</h3><Tag value="public" /></div>
    <form className="bio-row" onSubmit={event => { event.preventDefault(); if (executable && session.policy === 'public') void search() }}><Input aria-label={t('literatureQuery')} placeholder={t('literatureQuery')} value={query.value} maxLength={1000} onChange={event => query.set(event.target.value)} required disabled={!executable || session.policy !== 'public'} /><Button disabled={action.busy || !executable || session.policy !== 'public'}>{t('search')}</Button></form>
    <p className="bio-muted">Europe PMC · {t('publicQueryOnly')}</p>
    {results && <><p className="bio-muted">{submitted} · {results.items.length} {t('results')}</p><div className="bio-search-results">{results.items.map(candidate => <article className="bio-result" key={candidate.id}><h4>{candidate.title ?? candidate.providerId}</h4><p className="bio-muted">{candidate.authors?.join(', ')} · {candidate.year ?? '—'}</p><p>{candidate.abstract?.slice(0, 600) ?? t('noAbstract')}</p><p className="bio-muted">{candidate.availability.fullText ? t('fullTextAvailable') : t('abstractOnly')}</p><Button size="sm" variant="outline" disabled={action.busy || !executable} onClick={() => { void action.act(async () => { const result = await host.research.selectSource({ sessionId: session.id, candidateId: candidate.id, expectedRevision: session.revision }); if (result.status === 'identity-conflict') { setStatus('identityConflict'); return }; setSourceId(result.source.id); onChanged() }) }}>{t('selectSource')}</Button></article>)}</div>{results.nextCursor && <Button variant="outline" disabled={action.busy || !executable || session.policy !== 'public'} onClick={() => { void search(results.nextCursor) }}>{t('nextPage')}</Button>}</>}
  </section><section className="bio-card"><h3>{t('importPdf')}</h3><p className="bio-muted">{t('pdfImportHelp')}</p><Check label={t('declarePublicPdf')} checked={publicPdf} onChange={setPublicPdf} disabled={!executable} /><Button disabled={!executable || action.busy} onClick={() => { void action.act(async () => { const result = await host.importPdf({ sessionId: session.id, expectedRevision: session.revision, declaredPublic: publicPdf }); if (result.status === 'ok') { setSourceId(result.source.id); setPublicPdf(false); setStatus('imported'); onChanged() } else setStatus(`status.${result.status}`) }) }}>{t('choosePdf')}</Button>{status && <p role="status">{t(status)}</p>}</section></div>
    <ErrorNotice error={action.error || sources.error || query.error} />
    <div className="bio-section-title"><h3>{t('selectedSources')}</h3><span className="bio-muted">{session.selectedSourceIds?.length ?? 0}</span></div>
    <div className="bio-row"><select aria-label={t('source')} value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">{t('chooseSource')}</option>{sources.value?.map(source => <option value={source.id} key={source.id}>{source.title ?? source.identifiers.doi ?? source.id} · {t(`status.${source.policy}`)}</option>)}</select>{sourcePage > 0 && <Button size="sm" variant="ghost" onClick={() => setSourcePage(value => value - 1)}>{t('previousPage')}</Button>}{(sourcePage + 1) * 50 < (session.selectedSourceIds?.length ?? 0) && <Button size="sm" variant="ghost" onClick={() => setSourcePage(value => value + 1)}>{t('nextPage')}</Button>}</div>
    {!executable && <p className="bio-muted">{t('ownSessionInputOnly')}</p>}
    {sourceId && <SourceReader key={sourceId} sourceId={sourceId} sessionId={session.id} writable={writable} executable={executable} onChanged={onChanged} quotes={quotes} onQuotes={onQuotes} />}
  </div>
}
function SourceReader({ sourceId, sessionId, writable, executable, onChanged, quotes, onQuotes }: { sourceId: string; sessionId: string; writable: boolean; executable: boolean; onChanged(): void; quotes: SelectedQuote[]; onQuotes(value: SelectedQuote[]): void }) {
  const { host } = useBio(), t = useBioT(), action = useAction(), [cursor, setCursor] = useState<string>(), [selected, setSelected] = useState(''), [status, setStatus] = useState('')
  const source = useResource(() => host.research.getSource({ sourceId }), [sourceId]), catalog = useResource(() => host.research.listSourceSnapshots({ sourceId, pageSize: 20, ...(cursor ? { cursor } : {}) }), [sourceId, cursor])
  const snapshotId = selected || catalog.value?.items[0]?.id
  return <div className="bio-reader"><ErrorNotice error={source.error || catalog.error || action.error} />
    {source.value && <SourceMetadata source={source.value} writable={writable} onChanged={() => { source.reload(); onChanged() }} />}
    <div className="bio-row"><select aria-label={t('snapshot')} value={snapshotId ?? ''} onChange={event => setSelected(event.target.value)}><option value="">{t('chooseSnapshot')}</option>{catalog.value?.items.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.retrievedAt).toLocaleString()} · {t(`status.${snapshot.format}`)} · {snapshot.readUnits}/{snapshot.totalUnits} · {snapshot.id.slice(0, 8)}</option>)}</select>
      <Button size="sm" variant="outline" disabled={action.busy || !executable || source.value?.policy !== 'public'} onClick={() => { void action.act(async () => { const result = await host.research.readSourceText({ sourceId, sessionId }); if (result.status === 'ok') { setSelected(result.snapshot.id); catalog.reload(); onChanged() } else setStatus(`status.${result.status}`) }) }}>{t('readOpenText')}</Button>
      <Button size="sm" variant="ghost" onClick={catalog.reload}>{t('refresh')}</Button>{cursor && <Button size="sm" variant="ghost" onClick={() => setCursor(undefined)}>{t('firstPage')}</Button>}{catalog.value?.nextCursor && <Button size="sm" variant="ghost" onClick={() => setCursor(catalog.value?.nextCursor)}>{t('nextPage')}</Button>}</div>
    {status && <p role="status">{t(status)}</p>}{snapshotId && source.value && <SnapshotReader key={snapshotId} snapshotId={snapshotId} source={source.value} quotes={quotes} onQuotes={onQuotes} />}
  </div>
}
function SourceMetadata({ source, writable, onChanged }: { source: ResearchSource; writable: boolean; onChanged(): void }) {
  const { host } = useBio(), t = useBioT(), action = useAction()
  return <div className="bio-card"><h3>{source.title ?? t('untitledSource')}</h3><p>{source.authors?.join(', ')} {source.year ?? ''}</p><p className="bio-muted">{Object.entries(source.identifiers).map(([key, value]) => `${key}: ${value}`).join(' · ')}</p><div className="bio-row"><Tag value={source.policy} /><span>{t(source.license.status === 'known' ? 'licenseKnown' : 'licenseUnknown')}{source.license.status === 'known' ? ` · ${source.license.identifier}` : ''}</span></div>
    {!!source.metadataConflictFields?.length && <p className="bio-warning">{t('metadataConflict')}: {source.metadataConflictFields.join(', ')}</p>}
    {source.metadataConflictFields?.length && !source.metadataReview && writable ? <Button size="sm" variant="outline" disabled={action.busy} onClick={() => { void action.act(async () => { await host.research.confirmSourceMetadata({ sourceId: source.id, expectedRevision: source.revision ?? 1 }); onChanged() }) }}>{t('confirmMetadata')}</Button> : null}<ErrorNotice error={action.error} />
  </div>
}
function SnapshotReader({ snapshotId, source, quotes, onQuotes }: { snapshotId: string; source: ResearchSource; quotes: SelectedQuote[]; onQuotes(value: SelectedQuote[]): void }) {
  const { host } = useBio(), t = useBioT(), snapshot = useResource(() => host.research.getSnapshot({ snapshotId }), [snapshotId]), [blockId, setBlockId] = useState(''), [selection, setSelection] = useState({ start: 0, end: 0 })
  const block = snapshot.value?.blocks.find(block => block.id === blockId) ?? snapshot.value?.blocks[0]
  function addQuote(value: ReadingSnapshot) {
    if (!block || selection.end <= selection.start || quotes.length >= 100) return
    const quote = block.text.slice(selection.start, selection.end)
    if (!quote.trim() || quotes.some(item => item.snapshotId === value.id && item.blockId === block.id && item.start === selection.start && item.end === selection.end)) return
    onQuotes([...quotes, { snapshotId: value.id, blockId: block.id, start: selection.start, end: selection.end, quote, policy: value.policy,
      sourceTitle: source.title ?? source.id, locator: block.locator }])
  }
  return <section className="bio-card"><ErrorNotice error={snapshot.error} />{snapshot.value && <>
    <div className="bio-section-title"><h3>{t('readingSnapshot')}</h3><Tag value={snapshot.value.coverage.level} /><span>{snapshot.value.coverage.units.filter(unit => unit.status === 'read').length}/{snapshot.value.coverage.totalUnits} {t('unitsRead')}</span></div>
    <p className="bio-muted">{t('snapshotHelp')}</p><p className="bio-mono">SHA-256 {snapshot.value.contentHash}</p>
    <div className="bio-row"><select aria-label={t('readingUnit')} value={block?.id ?? ''} onChange={event => { setBlockId(event.target.value); setSelection({ start: 0, end: 0 }) }}>{snapshot.value.blocks.map(block => <option key={block.id} value={block.id}>{block.locator.kind === 'pdf-page' ? `${t('page')} ${block.locator.page}` : block.locator.kind === 'abstract' ? t('abstract') : `${t('paragraph')} ${block.locator.paragraphId}`}</option>)}</select>{block && <LocatorLabel locator={block.locator} />}</div>
    {block ? <><Textarea aria-label={t('sourceText')} readOnly value={block.text} className="bio-source-text" onSelect={event => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} /><div className="bio-row"><Button size="sm" disabled={selection.end <= selection.start || quotes.length >= 100} onClick={() => addQuote(snapshot.value!)}>{t('addExcerpt')}</Button><span className="bio-muted">UTF-16 {selection.start}–{selection.end}</span></div></> : <p>{t('noReadableText')}</p>}
    <details><summary>{t('coverageDetails')}</summary><div className="bio-coverage">{snapshot.value.coverage.units.map(unit => <span key={unit.unit}>{unit.unit}: {t(`status.${unit.status}`)} {unit.reason ? `(${unit.reason})` : ''}</span>)}</div></details>
  </>}</section>
}
