import React, { useState } from 'react'
import type { ResearchSpaceView } from '@bio-evidence/research-core'
import { useBio, useBioT, useResource, useAction, useDraft, scopeId, Button, Input, ErrorNotice } from './ui'
import { SessionDesk } from './SessionDesk'
import { MaterialsPanel } from './MaterialsPanel'
import { MembersPanel } from './MembersPanel'
import { bioCapabilities } from './capabilities'
export function SpaceDesk({ space, onSpaceChanged }: { space: ResearchSpaceView; onSpaceChanged(): void }) {
  const { host, account } = useBio(), t = useBioT(), [cursor, setCursor] = useState<string>(), [tab, setTab] = useState('sessions'), [name, setName] = useState(''), action = useAction()
  const capabilities = bioCapabilities(space.role, account.id)
  const navigation = useDraft([scopeId(space.scope), 'navigation-session'], ''), selected = navigation.value, setSelected = navigation.set
  const sessions = useResource(() => host.research.listSessions({ scope: space.scope, pageSize: 50, ...(cursor ? { cursor } : {}) }), [cursor])
  return <><div className="bio-page-title"><div><p className="bio-eyebrow">{t('workspace')}</p><h1>{space.name}</h1></div><span className="bio-muted">{t(`role.${space.role}`)}</span></div>
    <nav className="bio-tabs" aria-label={t('workspace')}>
      {['sessions', 'materials', ...(space.scope.kind === 'project' ? ['members'] : [])].map(value => <button key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}>{t(value)}</button>)}
    </nav>
    {tab === 'materials' ? <MaterialsPanel scope={space.scope} writable={capabilities.writeArtifacts} canManage={capabilities.manageMaterials} /> : tab === 'members' && space.scope.kind === 'project' ? <MembersPanel space={space} onChanged={onSpaceChanged} /> : <>
      <div className="bio-session-bar"><select aria-label={t('session')} value={selected} onChange={event => setSelected(event.target.value)}><option value="">{t('chooseSession')}</option>{sessions.value?.items.map(session => <option key={session.id} value={session.id}>{session.name} · {t(`status.${session.policy}`)}</option>)}</select>
      <Button variant="outline" size="sm" onClick={sessions.reload}>{t('refresh')}</Button>
      {cursor && <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>{t('firstPage')}</Button>}{sessions.value?.nextCursor && <Button variant="ghost" size="sm" onClick={() => setCursor(sessions.value?.nextCursor)}>{t('nextPage')}</Button>}
      {space.role !== 'viewer' && <form className="bio-row" onSubmit={event => { event.preventDefault(); void action.act(async () => { const session = await host.research.createSession({ scope: space.scope, name, sourceIds: [] }); setSelected(session.id); setCursor(undefined); setName(''); sessions.reload() }) }}><Input aria-label={t('newSessionName')} placeholder={t('newSessionName')} value={name} required maxLength={300} onChange={event => setName(event.target.value)} /><Button size="sm" disabled={action.busy}>{t('newSession')}</Button></form>}</div>
      <ErrorNotice error={sessions.error || action.error} />{selected ? <SessionDesk key={selected} sessionId={selected} scope={space.scope} writable={space.role !== 'viewer'} /> : <div className="bio-empty"><h2>{t('startResearch')}</h2><p>{t('sessionHelp')}</p></div>}
    </>}
  </>
}
