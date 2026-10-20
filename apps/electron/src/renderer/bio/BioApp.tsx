import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BioHostApi, BioClientState } from '../../shared/bio-api'
import { BioDraftVault, bioDraftOwner } from './drafts'
import { BioContext, Button, Input, Field, ErrorNotice, useBio, useBioT, useResource, useAction, useDraft, scopeId } from './ui'
import { SpaceDesk } from './SpaceDesk'
import { ModelSettings } from './ModelSettings'
import { spaceAccessChanged } from './capabilities'
import './bio.css'
import logo from '../../../branding/bio.svg'
export default function BioApp({ host }: { host: BioHostApi }) {
  const t = useBioT(), { i18n } = useTranslation(), vault = useMemo(() => new BioDraftVault(), [])
  const [state, setState] = useState<BioClientState>({ origin: '', account: null, status: 'signed-out', epoch: 0 })
  const [origin, setOrigin] = useState(''), [username, setUsername] = useState(''), [password, setPassword] = useState('')
  const action = useAction()
  const [dismissedNotice, setDismissedNotice] = useState('')
  const noticeId = `${state.epoch}:${state.viewRevision ?? 0}`
  const stateVersion = useRef(0)
  useEffect(() => { let live = true
    const unsubscribe = host.onState(value => { if (live) { stateVersion.current++; setState(value); setOrigin(current => current || value.origin) } })
    const version = stateVersion.current
    void host.account.current().then(value => { if (live && version === stateVersion.current) { setState(value); setOrigin(current => current || value.origin) } }).catch(() => {})
    const timer = setInterval(() => { void host.account.current().catch(() => {}) }, 10000)
    return () => { live = false; unsubscribe(); clearInterval(timer) }
  }, [host])
  return <div className="bio-shell">
    <header className="bio-header"><a className="bio-brand" href="#" onClick={event => event.preventDefault()}><img className="bio-mark" src={logo} alt="" />BioEvidence<span className="bio-beta">RESEARCH WORKSPACE</span></a>
      <div className="bio-row"><select aria-label={t('language')} value={i18n.resolvedLanguage?.startsWith('zh') ? 'zh-Hans' : 'en'} onChange={event => { void i18n.changeLanguage(event.target.value) }}><option value="zh-Hans">简体中文</option><option value="en">English</option></select>
        {state.account && <><span>{state.account.username}</span><Button variant="outline" size="sm" onClick={() => { setPassword(''); void host.account.logout() }}>{t('logout')}</Button></>}</div>
    </header>
    {state.account && state.status === 'connected' && state.errorCode === 'BIO_ACCESS_DENIED' && dismissedNotice !== noticeId && <div className="bio-warning bio-row" role="alert"><span>{t('accessChangedDraftsKept')}</span><Button size="sm" variant="ghost" onClick={() => setDismissedNotice(noticeId)}>{t('dismiss')}</Button></div>}
    {state.account && state.status === 'connected' ? <BioContext.Provider value={{ host, account: state.account, vault, identityKey: bioDraftOwner(state.origin, state.account.id) }}><Workspace key={`${state.origin}:${state.account.id}:${state.epoch}:${state.viewRevision ?? 0}`} /></BioContext.Provider>
      : <main className="bio-login"><section className="bio-login-intro"><p className="bio-eyebrow">BIOEVIDENCE / 01</p><h1>{t('loginHeadline')}</h1><p>{t('loginDescription')}</p><div className="bio-divider" /><p className="bio-muted">{t('privacyPromise')}</p></section>
        <form className="bio-card bio-login-form" onSubmit={event => { event.preventDefault(); const secret = password; setPassword(''); void action.act(async () => { await host.account.login(origin, username, secret) }) }}>
          <h2>{t(state.status === 'disconnected' ? 'disconnected' : 'signIn')}</h2><p className="bio-muted">{t(host.platform === 'desktop' ? 'desktopOriginHelp' : 'accountHelp')}</p>
          <Field label={t('serviceOrigin')}><Input aria-label={t('serviceOrigin')} type="url" value={origin} required disabled={host.platform === 'web'} onChange={event => setOrigin(event.target.value)} placeholder="https://research.example.org" /></Field>
          <Field label={t('username')}><Input autoComplete="username" aria-label={t('username')} value={username} required minLength={3} maxLength={64} onChange={event => setUsername(event.target.value)} /></Field>
          <Field label={t('password')}><Input autoComplete="current-password" aria-label={t('password')} type="password" value={password} required maxLength={1024} onChange={event => setPassword(event.target.value)} /></Field>
          <ErrorNotice error={action.error || (state.errorCode ? { code: state.errorCode } : undefined)} />
          <Button type="submit" disabled={action.busy}>{t(action.busy ? 'connecting' : 'signIn')}</Button>
          {state.account && <Button type="button" variant="outline" onClick={() => { void host.account.current() }}>{t('refresh')}</Button>}
        </form></main>}
  </div>
}
function Workspace() {
  const { host, account } = useBio(), t = useBioT(), spaces = useResource(() => host.research.listSpaces({}), [])
  const navigation = useDraft(['navigation-workspace'], ''), selected = navigation.value, setSelected = navigation.set
  const [settings, setSettings] = useState(false), [name, setName] = useState(''), action = useAction()
  const previousAccess = useRef<NonNullable<typeof spaces.value>>()
  const [accessChanged, setAccessChanged] = useState(false)
  useEffect(() => {
    if (!spaces.value) return
    if (previousAccess.current && spaceAccessChanged(previousAccess.current, spaces.value)) setAccessChanged(true)
    previousAccess.current = spaces.value
  }, [spaces.value])
  const current = spaces.value?.find(space => scopeId(space.scope) === selected) ?? spaces.value?.[0]
  useEffect(() => { const timer = setInterval(spaces.reload, 10000); return () => clearInterval(timer) }, [spaces.reload])
  return <>{accessChanged && <div className="bio-warning bio-row" role="alert"><span>{t('accessChangedDraftsKept')}</span><Button size="sm" variant="ghost" onClick={() => setAccessChanged(false)}>{t('dismiss')}</Button></div>}<div className="bio-workspace"><aside className="bio-sidebar"><p className="bio-eyebrow">{t('workspaces')}</p>
    {spaces.value?.map(space => <button className={`bio-space ${current && scopeId(current.scope) === scopeId(space.scope) && !settings ? 'is-active' : ''}`} key={scopeId(space.scope)} onClick={() => { setSelected(scopeId(space.scope)); setSettings(false) }}><span>{space.name}</span><small>{t(`role.${space.role}`)}</small></button>)}
    <ErrorNotice error={spaces.error} />
    <form className="bio-create" onSubmit={event => { event.preventDefault(); void action.act(async () => { const created = await host.research.createProject({ name }); setSelected(`project:${created.id}`); setSettings(false); setName(''); spaces.reload() }) }}>
      <Input aria-label={t('projectName')} placeholder={t('projectName')} value={name} maxLength={300} onChange={event => setName(event.target.value)} required /><Button variant="outline" size="sm" disabled={action.busy}>{t('createProject')}</Button><ErrorNotice error={action.error} />
    </form><div className="bio-sidebar-bottom">{account.administrator && <Button variant="ghost" onClick={() => setSettings(true)}>{t('modelSettings')}</Button>}<p className="bio-muted">{t('privacyPromise')}</p></div>
  </aside><main className="bio-main">{settings ? <ModelSettings /> : current ? <SpaceDesk key={scopeId(current.scope)} space={current} onSpaceChanged={spaces.reload} /> : <div className="bio-empty">{t(spaces.loading ? 'loading' : 'noWorkspaces')}</div>}</main></div></>
}
