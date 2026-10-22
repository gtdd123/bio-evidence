import './execution.css'
import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ResearchSession, ResearchRunView, ResearchExecutionMode, ResearchConnectionView } from '@bio-evidence/research-core'
import { useBio, useBioT, useResource, useDraft, ErrorNotice } from './ui'
import { RESEARCH_CHANNELS as R } from '@bio-evidence/research-core'
import { ResearchRunStateAdapter, type ResearchRunClientState } from '@craft-agent/shared/protocol'
import { recentModelSuccess } from './execution-state'
interface ExecutionSelection { connectionId: string; model: string; mode: ResearchExecutionMode; connection?: ResearchConnectionView; connections: ResearchConnectionView[]; error?: unknown; view?: ResearchRunView; state: ResearchRunClientState; adapter: React.MutableRefObject<ResearchRunStateAdapter | undefined>; selectRun(id: string): Promise<void> }
const Context = createContext<ExecutionSelection>(null!)
export const useExecutionSelection = () => useContext(Context)
export interface ModelRouteOption { id: string; label: string; group: 'cloud' | 'lab' }
export function RouterControls({ options, value, onChange, mode, onMode, successAt, demo = false }: { options: ModelRouteOption[]; value: string; onChange(value: string): void; mode: ResearchExecutionMode; onMode(value: ResearchExecutionMode): void; successAt?: number; demo?: boolean }) {
  const t = useBioT()
  return <div className="bio-execution-controls"><div className="bio-model-router"><div className="bio-router-caption"><span className={`bio-connection-dot ${successAt ? 'is-success' : ''}`} aria-label={t(successAt ? 'recentModelSuccess' : 'modelNotTested')} />MODEL ROUTER <span className="bio-protocol-tag">AgentBackend · Stream SSE</span></div>
    <select aria-label={t('modelRouter')} value={value} disabled={!options.length} onChange={event => onChange(event.target.value)}><option value="">{t(options.length ? 'chooseModel' : 'noConnectionHelp')}</option>{(['cloud', 'lab'] as const).map(group => <optgroup label={group === 'cloud' ? 'Cloud API' : 'Lab Intranet GPU'} key={group}>{options.filter(item => item.group === group).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}{group === 'lab' && !options.some(item => item.group === group) && <option disabled value="unconfigured-lab">{t('labHttpsRequired')}</option>}</optgroup>)}</select>
    <span className="bio-router-status">{demo ? t('demoRouteOnly') : successAt ? `${t('recentModelSuccess')} · ${new Date(successAt).toLocaleTimeString()}` : t('modelNotTested')}</span>
  </div><div className="bio-permission-control"><span className="bio-router-caption">PRETOOLUSE POLICY</span><div className="bio-mode-segments" role="group" aria-label={t('executionMode')}>{(['safe', 'ask', 'allow-all'] as const).map(item => <button type="button" key={item} aria-pressed={mode === item} title={t(`modeHelp.${item}`)} onClick={() => onMode(item)}>{item === 'safe' ? '🛡️ Safe' : item === 'ask' ? '⚡ Ask' : '🚀 Allow-All'}</button>)}</div><span className="bio-router-status">{t(`modeHelp.${mode}`)}</span></div></div>
}
export function SessionExecutionProvider({ session, children }: { session: ResearchSession; children: React.ReactNode }) {
  const { host } = useBio(), selection = useDraft([session.id, 'model-route'], ''), modeDraft = useDraft([session.id, 'execution-mode'], 'ask')
  const choices = useResource(() => host.research.listModelConnections({ scope: session.scope }), [session.id])
  const selectedRun = useDraft([session.id, 'navigation-run'], ''), restored = useRef(selectedRun.value), chosen = useRef(false), adapter = useRef<ResearchRunStateAdapter>()
  const [state, setState] = useState<ResearchRunClientState>({ status: 'idle', page: { items: [] } }), [now, setNow] = useState(Date.now)
  const reloadChoices = choices.reload, view = state.selected
  useEffect(() => {
    let live = true, ticks = 0
    const value = new ResearchRunStateAdapter({ invoke: (channel, input) => channel === R.LIST_RUNS ? host.research.listRuns(input) : host.research.getRun(input), on: (_, cb) => host.research.onEvent(cb) }, session.id, next => { if (live) setState(next) })
    adapter.current = value
    if (restored.current) { chosen.current = true; void value.selectRun(restored.current) }
    else void value.refresh().then(() => { if (!live || chosen.current) return; const first = [...value.state.page.items].sort((a, b) => b.createdAt - a.createdAt)[0]; if (first) { chosen.current = true; void value.selectRun(first.id) } })
    const timer = setInterval(() => { setNow(Date.now()); void value.refresh(); if (++ticks % 10 === 0) reloadChoices() }, 3000)
    return () => { live = false; clearInterval(timer); adapter.current = undefined; value.close() }
  }, [session.id, host.research, reloadChoices])
  async function selectRun(id: string) { chosen.current = true; selectedRun.set(id); await adapter.current?.selectRun(id) }
  const connections = choices.value ?? [], options = connections.flatMap(connection => connection.models.map(model => ({ id: JSON.stringify([connection.slug, model.id]), group: connection.deployment ?? 'cloud', label: `${connection.deployment === 'lab' ? '🏢 Lab GPU' : 'Cloud'} · ${connection.name} · ${model.id}` })))
  const selected = selection.value || options[0]?.id || ''
  let connectionId = '', model = ''
  try { [connectionId, model] = JSON.parse(selected) } catch { /* no authorized connection */ }
  const connection = connections.find(item => item.slug === connectionId), mode = (['safe', 'ask', 'allow-all'].includes(modeDraft.value) ? modeDraft.value : 'ask') as ResearchExecutionMode
  const successAt = recentModelSuccess(view, connection, model, now), slot = typeof document === 'undefined' ? null : document.getElementById('bio-execution-slot')
  const controls = <RouterControls options={options} value={selected} onChange={selection.set} mode={mode} onMode={modeDraft.set} successAt={successAt} />
  return <Context.Provider value={{ connectionId, model, mode, connection, connections, error: choices.error, view, state, adapter, selectRun }}>{slot ? createPortal(controls, slot) : controls}<ErrorNotice error={selection.error || modeDraft.error} />{children}</Context.Provider>
}
