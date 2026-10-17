import React, { createContext, useContext, useEffect, useRef, useState, useCallback, type DependencyList } from 'react'
import { useTranslation } from 'react-i18next'
import type { BioHostApi } from '../../shared/bio-api'
import type { PublicAccount, ResearchScope, Citation, TextBlock } from '@bio-evidence/research-core'
type Locator = TextBlock['locator']
import { BioDraftVault } from './drafts'
export { Button } from '../components/ui/button'
export { Input } from '../components/ui/input'
export { Textarea } from '../components/ui/textarea'
export { DataTable } from '../components/ui/data-table'
export const BioContext = createContext<{ host: BioHostApi; account: PublicAccount; vault: BioDraftVault; identityKey: string }>(null!)
export const useBio = () => useContext(BioContext)
export function useBioT() { const { t } = useTranslation(); return (key: string, values?: Record<string, unknown>) => t(`bio.${key}`, values) }
export function scopeId(scope: ResearchScope) { return scope.kind === 'personal' ? `personal:${scope.ownerId}` : `project:${scope.projectId}` }
export type SelectedQuote = Citation & { sourceTitle: string; locator: Locator; policy: string }
export function ErrorNotice({ error }: { error: unknown }) {
  const t = useBioT(); if (!error) return null
  const code = (error as { code?: string }).code
  return <p role="alert" className="bio-error">{t(code === 'BIO_REVISION_CONFLICT' ? 'conflict' : code === 'BIO_ACCESS_DENIED' ? 'accessLost' : code === 'BIO_POLICY_DENIED' ? 'privateCloudBlocked' : code === 'BIO_MODEL_BUDGET' || code === 'BIO_DRAFT_BUDGET' ? 'budget' : 'requestFailed')}{code && /^BIO_[A-Z_]{1,60}$/.test(code) ? ` · ${code}` : ''}</p>
}
export function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), mounted = useRef(true), running = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function act(work: () => Promise<void>) {
    if (running.current) return
    running.current = true; setBusy(true); setError(undefined)
    try { await work() } catch (error) { if (mounted.current) setError(error) }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  return { busy, error, act }
}
export function useResource<T>(load: () => Promise<T>, deps: DependencyList) {
  const [value, setValue] = useState<T>(), [error, setError] = useState<unknown>(), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
  const previous = useRef<DependencyList>()
  const loader = useRef(load); loader.current = load
  const dependencies = useRef(deps); dependencies.current = deps
  useEffect(() => { let active = true
    const current = dependencies.current
    if (!previous.current || current.some((value, index) => !Object.is(value, previous.current![index])) || current.length !== previous.current.length) setValue(undefined)
    previous.current = current; setError(undefined); setLoading(true)
    void loader.current().then(result => { if (active) setValue(result) }).catch(error => { if (active) { setError(error); setValue(undefined) } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // Callers supply stable resource identity values; changing loader closures alone must not refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, revision])
  const reload = useCallback(() => setRevision(value => value + 1), [])
  return { value, error, loading, reload }
}
export function useDraft(resource: readonly string[], initial: string) {
  const { vault, identityKey } = useBio(), [value, setValue] = useState(() => vault.get(identityKey, resource) ?? initial), [error, setError] = useState<unknown>()
  function retain(next: string) { try { vault.set(identityKey, resource, next); setError(undefined); return true } catch { setError({ code: 'BIO_DRAFT_BUDGET' }); return false } }
  return { value, error, set: (next: string) => { setValue(next); retain(next) },
    stage: (next: string) => { if (!retain(next)) return false; setValue(next); return true },
    clear: () => vault.remove(identityKey, resource) }
}
export function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="bio-field"><span>{label}</span>{children}</label> }
export function Check({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  return <label className="bio-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>
}
export function Tag({ value }: { value: string }) { const t = useBioT(); return <span className={`bio-tag bio-tag-${value}`}>{t(`status.${value}`)}</span> }
export function LocatorLabel({ locator }: { locator: Locator }) { const t = useBioT(); return <span>{locator.kind === 'pdf-page' ? `${t('page')} ${locator.page}` : locator.kind === 'abstract' ? t('abstract') : `${locator.section ?? t('paragraph')} · ${locator.paragraphId}`}</span> }
