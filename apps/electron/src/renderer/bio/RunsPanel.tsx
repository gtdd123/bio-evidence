import React, { useState } from 'react'
import { StartResearchRunSchema, type ResearchRunView, type StartResearchRun, type EvidenceView } from '@bio-evidence/research-core'
import type { SessionPanelProps } from './SessionDesk'
import { useExecutionSelection } from './ExecutionControls'
import { TraceTimeline } from './TraceTimeline'
import { bioCapabilities, runProgress } from './capabilities'
import { useBio, useBioT, useResource, useAction, useDraft, Button, Textarea, Field, Check, Tag, ErrorNotice, type SelectedQuote } from './ui'
export function RunsPanel({ session, writable, onChanged, quotes, onOpenArtifact }: SessionPanelProps & { quotes: SelectedQuote[]; onOpenArtifact(kind: 'evidence' | 'report', id: string): void }) {
  const { host, account } = useBio(), t = useBioT(), action = useAction(), question = useDraft([session.id, 'cloud-question'], '')
  const submission = useDraft([session.id, 'cloud-submission'], '')
  const route = useExecutionSelection(), { connectionId, model, mode, connection, state, adapter } = route
  const [purpose, setPurpose] = useState<'evidence' | 'report'>('evidence'), [declared, setDeclared] = useState(false), [retryDeclared, setRetryDeclared] = useState(false)
  const [evidence, setEvidence] = useState<EvidenceView[]>([]), [evidenceCursor, setEvidenceCursor] = useState<string>()
  const connections = { value: route.connections, error: route.error }
  const choices = useResource(() => host.research.listArtifacts({ sessionId: session.id, pageSize: 100, ...(evidenceCursor ? { cursor: evidenceCursor } : {}) }), [session.id, evidenceCursor])
  const permissions = bioCapabilities(writable ? 'editor' : 'viewer', account.id, session.ownerId, state.selected?.run.actorId)
  const cloudAllowed = permissions.executeSession && session.policy === 'public'
  const blocks = [...quotes.map(({ snapshotId, blockId, start, end, quote, policy }) => ({ snapshotId, blockId, start, end, quote, policy })), ...evidence.flatMap(view => view.revision.citations.map(citation => ({ ...citation, policy: view.effectivePolicy })))]
    .filter((block, index, all) => all.findIndex(other => other.snapshotId === block.snapshotId && other.blockId === block.blockId && other.start === block.start && other.end === block.end) === index)
  const pending = submission.value ? StartResearchRunSchema.safeParse(JSON.parse(submission.value)) : undefined
  const canStart = cloudAllowed && declared && !!connection && connection.models.some(item => item.id === model) && !!question.value.trim() && blocks.length > 0 && blocks.length <= 100 && blocks.every(block => block.policy === 'public') && !submission.value
  async function submit(input: StartResearchRun) {
    if (!submission.stage(JSON.stringify(input))) throw { code: 'BIO_DRAFT_BUDGET' }
    const result = await host.research.startRun(input)
    submission.clear(); submission.set(''); setDeclared(false); setRetryDeclared(false)
    await route.selectRun(result.run.id); onChanged()
  }
  return <div className="bio-panel"><div className="bio-card"><h3>{t('publicAgent')}</h3><p className="bio-muted">{t('cloudInputHelp')}</p>
    <div className="bio-row"><Field label={t('output')}><select value={purpose} onChange={event => setPurpose(event.target.value as 'evidence' | 'report')}><option value="evidence">{t('evidence')}</option><option value="report">{t('reports')}</option></select></Field></div>
    {connections.value?.length === 0 && <p className="bio-warning">{t('noConnectionHelp')}</p>}
    <Field label={t('publicQuestion')}><Textarea aria-label={t('publicQuestion')} value={question.value} maxLength={32000} onChange={event => question.set(event.target.value)} disabled={!cloudAllowed} /></Field>
    {purpose === 'report' && <details><summary>{t('chooseEvidence')}</summary>{choices.value?.items.filter(item => item.kind === 'evidence').map(item => <Check key={item.value.id} label={`v${item.value.revision} · ${item.value.title}`} checked={evidence.some(view => view.revision.id === item.value.id)} disabled={!cloudAllowed || action.busy} onChange={checked => { void action.act(async () => {
      if (!checked) { setEvidence(values => values.filter(view => view.revision.id !== item.value.id)); return }
      const view = await host.research.getEvidence({ revisionId: item.value.id }); if (view.effectivePolicy !== 'public') throw { code: 'BIO_POLICY_DENIED' }
      setEvidence(values => [...values, view])
    }) }} />)}<div className="bio-row">{evidenceCursor && <Button size="sm" variant="ghost" onClick={() => setEvidenceCursor(undefined)}>{t('firstPage')}</Button>}{choices.value?.nextCursor && <Button size="sm" variant="ghost" onClick={() => setEvidenceCursor(choices.value?.nextCursor)}>{t('nextPage')}</Button>}</div></details>}
    <details className="bio-input-preview" open><summary>{t('outgoingInput')} · {blocks.length} {t('excerpts')}</summary>
      <p>{question.value || t('emptyQuestion')}</p>{blocks.map((block, index) => <div className="bio-excerpt" key={`${block.snapshotId}:${block.blockId}:${index}`}><Tag value={block.policy} /><span>{block.blockId} · UTF-16 {block.start}–{block.end}</span><p>{block.quote}</p></div>)}
      {evidence.map(view => <div className="bio-excerpt" key={view.revision.id}><strong>{view.revision.claim}</strong><p>{view.revision.factSummary}</p><p>{view.revision.limitations}</p><p>{view.revision.missingInformation?.join('\n')}</p><Button size="sm" variant="ghost" onClick={() => setEvidence(values => values.filter(item => item.revision.id !== view.revision.id))}>{t('remove')}</Button></div>)}
    </details><Check label={t('declarePublicRun')} checked={declared} onChange={setDeclared} disabled={!cloudAllowed} />
    {!cloudAllowed && <p className="bio-warning">{t(session.policy !== 'public' ? 'privateCloudBlocked' : 'ownSessionExecutionOnly')}</p>}
    <Button disabled={!canStart || action.busy} onClick={() => { void action.act(async () => {
      await submit(StartResearchRunSchema.parse({ sessionId: session.id, expectedRevision: session.revision, operationId: crypto.randomUUID(), connectionId, model, executionMode: mode, question: question.value, purpose, declaredPublic: true,
        blocks: blocks.map(({ snapshotId, blockId, start, end }) => ({ snapshotId, blockId, start, end })), evidenceRevisionIds: evidence.map(view => view.revision.id) }))
    }) }}>{t('startRun')}</Button>
    {pending?.success && <div className="bio-warning"><p>{t(action.busy ? 'submitting' : 'submissionUnknown')}</p><Button variant="outline" disabled={action.busy || !cloudAllowed} onClick={() => { void action.act(async () => { await submit(pending.data) }) }}>{t('checkSubmission')}</Button><Button variant="ghost" disabled={action.busy} onClick={() => { submission.clear(); submission.set('') }}>{t('discardSubmission')}</Button></div>}
    <ErrorNotice error={action.error || connections.error || choices.error || question.error || submission.error} />
  </div><section className="bio-card"><div className="bio-section-title"><h3>{t('runHistory')}</h3><Button size="sm" variant="ghost" onClick={() => { void adapter.current?.refresh() }}>{t('refresh')}</Button></div>
    <ErrorNotice error={state.errorCode ? { code: state.errorCode } : undefined} />
    {state.page.items.map(run => <div className="bio-run-row" key={run.id}><button className="bio-link" onClick={() => { void route.selectRun(run.id) }}>{run.id.slice(0, 8)} · {new Date(run.createdAt).toLocaleString()}</button><Tag value={run.state} /><span className="bio-muted">{run.step ? t(`step.${run.step}`) : ''}</span></div>)}
    <div className="bio-row"><Button variant="ghost" size="sm" onClick={() => { void adapter.current?.pageAfter() }}>{t('firstPage')}</Button>{state.page.nextCursor && <Button variant="ghost" size="sm" onClick={() => { void adapter.current?.pageAfter(state.page.nextCursor) }}>{t('nextPage')}</Button>}</div>
    {state.selected && <RunDetails view={state.selected} canApprove={permissions.executeSession && state.selected.run.actorId === account.id} onDecision={(requestId, decision) => { void action.act(async () => { await host.research.decideTool({ runId: state.selected!.run.id, expectedGeneration: state.selected!.run.generation, requestId, decision }); await adapter.current?.refresh() }) }} canCancel={permissions.cancelRun} retryAllowed={cloudAllowed && !submission.value} retryDeclared={retryDeclared} onRetryDeclared={setRetryDeclared}
      onOpenArtifact={id => { void action.act(async () => { const kind = state.selected!.purpose; const view = kind === 'evidence' ? await host.research.getEvidence({ revisionId: id }) : await host.research.getReport({ revisionId: id }); if (view.revision.sessionId !== session.id) throw { code: 'BIO_ACCESS_DENIED' }; onOpenArtifact(kind, id) }) }}
      onCancel={() => { void action.act(async () => { await host.research.cancelRun({ runId: state.selected!.run.id, expectedGeneration: state.selected!.run.generation }); await adapter.current?.refresh(); onChanged() }) }}
      onRetry={() => { void action.act(async () => { const view = state.selected!; await submit(StartResearchRunSchema.parse({ sessionId: session.id, expectedRevision: session.revision, operationId: crypto.randomUUID(), retryOfRunId: view.run.id,
        purpose: view.purpose, ...(view.executionMode ? { executionMode: view.executionMode } : {}), question: view.input.question, connectionId: view.manifest.connectionId, model: view.manifest.model, declaredPublic: true,
        blocks: view.input.blocks.map(({ snapshotId, blockId, start, end }) => ({ snapshotId, blockId, start, end })), evidenceRevisionIds: view.input.evidence.map(item => item.id) })) }) }} busy={action.busy} />}
  </section></div>
}
function RunDetails({ view, canCancel, retryAllowed, retryDeclared, onRetryDeclared, onCancel, onRetry, onOpenArtifact, busy, canApprove, onDecision }: { view: ResearchRunView; canCancel: boolean; retryAllowed: boolean; retryDeclared: boolean; onRetryDeclared(value: boolean): void; onCancel(): void; onRetry(): void; onOpenArtifact(id: string): void; busy: boolean; canApprove: boolean; onDecision(requestId: string, decision: 'approve' | 'deny'): void }) {
  const t = useBioT(), terminalRetry = ['failed', 'interrupted', 'cancelled'].includes(view.run.state)
  const progress = runProgress(view.run, view.steps)
  const stepNames = new Set(['prepare', 'retrieve', 'parse', 'evidence', 'validate', 'report', 'model-result', 'reuse', 'failure'])
  return <div className="bio-run-details"><div className="bio-row"><Tag value={view.run.state} /><Tag value={view.projectionStatus} /><span>{view.manifest.model}</span></div>
    <p>{t('currentStep')}: {view.run.state === 'running' ? `${t('status.running')} · ${t(view.purpose === 'evidence' ? 'evidence' : 'reports')}` : view.run.step ? t(`step.${view.run.step}`) : '—'} · {t('preparedSources')}: {progress.preparedSources} / {progress.totalSources}</p>
    <TraceTimeline view={view} canApprove={canApprove} busy={busy} onDecision={onDecision} />
    <ol>{view.steps.map(step => <li key={step.id}>{stepNames.has(step.id) ? t(`step.${step.id}`) : step.id} · <Tag value={step.state} /></li>)}</ol>
    <div className="bio-row"><strong>{t('runArtifacts')}</strong>{view.run.artifactIds.length ? view.run.artifactIds.map(id => <Button key={id} variant="outline" size="sm" disabled={busy} onClick={() => onOpenArtifact(id)}>{t(view.purpose === 'evidence' ? 'openEvidence' : 'openReport')} · {id.slice(0, 8)}</Button>) : <span className="bio-muted">{t('noArtifacts')}</span>}</div>
    {view.modelRequests.some(request => request.state === 'unknown' || request.state === 'pending') && <p className="bio-warning">{t('unknownModelReceipt')}</p>}
    {view.projectionPending && <p className="bio-warning">{t('projectionPending')}</p>}{view.projectionStatus === 'covered' && <p className="bio-muted">{t('projectionCovered')}</p>}
    <p className="bio-muted">{t('usageUnknown')}</p><ErrorNotice error={view.errorCode ? { code: view.errorCode } : undefined} />
    <details><summary>{t('frozenInput')}</summary><pre className="bio-json">{JSON.stringify({ manifest: view.manifest, input: view.input, modelRequests: view.modelRequests }, null, 2)}</pre></details>
    {canCancel && ['queued', 'running'].includes(view.run.state) && <Button disabled={busy} variant="outline" onClick={onCancel}>{t('cancelRun')}</Button>}
    {terminalRetry && <><Check label={t('retryConfirmation')} checked={retryDeclared} onChange={onRetryDeclared} disabled={!retryAllowed} /><Button disabled={!retryAllowed || !retryDeclared || busy} variant="outline" onClick={onRetry}>{t('retryRun')}</Button></>}
  </div>
}
