import React, { useEffect, useRef, useState } from 'react'
import type { ResearchScope, MaterialRoot, MaterialEntry, MaterialPage, MaterialSearchResult, MaterialAnnotation, MaterialImageResult } from '@bio-evidence/research-core'
import { useBio, useBioT, useResource, useAction, useDraft, Button, Input, Textarea, Field, Tag, ErrorNotice } from './ui'
import { materialNoteDraft, materialNoteContent } from './material-note-draft'
export function MaterialsPanel({ scope, writable, canManage }: { scope: ResearchScope; writable: boolean; canManage: boolean }) {
  const { host } = useBio(), t = useBioT(), action = useAction(), [selected, setSelected] = useState(''), [cursor, setCursor] = useState<string>(), [grantId, setGrantId] = useState(''), [relativeDir, setRelativeDir] = useState('')
  const grants = useResource(() => host.research.listMaterialGrants({ scope }), []), roots = useResource(() => host.research.listMaterials({ scope, pageSize: 100, ...(cursor ? { cursor } : {}) }), [cursor])
  const root = roots.value?.items.find(item => item.id === selected)
  return <div className="bio-panel"><div className="bio-section-title"><h2>{t('materials')}</h2><Tag value="restricted" /></div><p className="bio-muted">{t('materialsHelp')}</p>
    <div className="bio-row"><select aria-label={t('materialRoot')} value={selected} onChange={event => setSelected(event.target.value)}><option value="">{t('chooseDirectory')}</option>{roots.value?.items.map(root => <option key={root.id} value={root.id}>{root.label} / {root.relativeDir}</option>)}</select><Button variant="ghost" onClick={roots.reload}>{t('refresh')}</Button>{cursor && <Button variant="ghost" onClick={() => setCursor(undefined)}>{t('firstPage')}</Button>}{roots.value?.nextCursor && <Button variant="ghost" onClick={() => setCursor(roots.value?.nextCursor)}>{t('nextPage')}</Button>}</div>
    {canManage && <details className="bio-card"><summary>{t('registerDirectory')}</summary><form className="bio-row" onSubmit={event => { event.preventDefault(); void action.act(async () => { const root = await host.research.registerMaterial({ grantId, relativeDir }); setSelected(root.id); setCursor(undefined); roots.reload() }) }}>
      <Field label={t('authorizedGrant')}><select value={grantId} required onChange={event => setGrantId(event.target.value)}><option value="">{t('chooseGrant')}</option>{grants.value?.map(grant => <option key={grant.id} value={grant.id}>{grant.label}</option>)}</select></Field><Field label={t('relativeDirectory')}><Input value={relativeDir} maxLength={4096} onChange={event => setRelativeDir(event.target.value)} placeholder={t('grantRootHint')} /></Field><Button disabled={action.busy}>{t('register')}</Button></form><p className="bio-muted">{t('grantsHelp')}</p></details>}
    <ErrorNotice error={roots.error || grants.error || action.error} />{root && <MaterialRootBrowser key={root.id} root={root} writable={writable} />}
    {!roots.loading && !roots.error && roots.value && roots.value.items.length === 0 && !cursor && <p role="status" className="bio-muted">{t('noMaterialsConnected')}</p>}
  </div>
}
function MaterialRootBrowser({ root, writable }: { root: MaterialRoot; writable: boolean }) {
  const [directory, setDirectory] = useState('')
  return <MaterialDirectory key={directory} root={root} writable={writable} relativeDir={directory} onDirectory={setDirectory} />
}
function MaterialDirectory({ root, writable, relativeDir, onDirectory }: { root: MaterialRoot; writable: boolean; relativeDir: string; onDirectory(value: string): void }) {
  const { host } = useBio(), t = useBioT(), action = useAction(), [cursor, setCursor] = useState<string>(), [selected, setSelected] = useState<MaterialEntry>(), [query, setQuery] = useState(''), [search, setSearch] = useState<MaterialSearchResult>()
  const state = useResource(() => host.research.getMaterialIndex({ rootId: root.id, relativeDir }), [root.id, relativeDir])
  const page = useResource(() => host.research.listMaterialDirectory({ rootId: root.id, relativeDir, pageSize: 100, ...(cursor ? { cursor } : {}) }), [root.id, relativeDir, cursor, state.value?.generation])
  const [indexing, setIndexing] = useState(false)
  return <section><div className="bio-section-title"><h3>{root.label} / {relativeDir || t('rootDirectory')}</h3>{indexing ? <span role="status">{t('indexing')}</span> : state.value && <Tag value={state.value.status} />}</div>
    <div className="bio-row">{relativeDir && <Button variant="outline" size="sm" onClick={() => onDirectory(relativeDir.split('/').slice(0, -1).join('/'))}>{t('parentDirectory')}</Button>}<Button variant="outline" size="sm" disabled={action.busy || !writable} onClick={() => { void action.act(async () => { setSelected(undefined); setSearch(undefined); setIndexing(true); try { await host.research.indexMaterialDirectory({ rootId: root.id, relativeDir }); setCursor(undefined); state.reload(); page.reload() } finally { setIndexing(false) } }) }}>{t('indexDirectory')}</Button><Button variant="ghost" size="sm" onClick={() => { state.reload(); page.reload() }}>{t('refresh')}</Button></div>
    <p className="bio-muted">{t('indexHelp')}{state.value ? ` · ${state.value.count}` : ''}{state.value?.reason ? ` · ${state.value.reason}` : ''}</p>
    <ErrorNotice error={action.error || state.error || page.error} />
    <form className="bio-row" onSubmit={event => { event.preventDefault(); void action.act(async () => { setSearch(undefined); setSearch(await host.research.searchMaterialText({ rootId: root.id, query })) }) }}><Input aria-label={t('localTextQuery')} placeholder={t('localTextQuery')} value={query} maxLength={200} required onChange={event => setQuery(event.target.value)} /><Button variant="outline" disabled={action.busy}>{t('searchLocal')}</Button></form>
    {search && <div className="bio-card"><p>{t('localSearchBudget')} · {search.filesRead} / {search.bytesRead} bytes{search.truncated ? ` · ${t('truncated')}` : ''}</p>{search.matches.map(match => <div key={match.fileId}><strong>{match.name}</strong><p>{match.snippet}</p></div>)}<p className="bio-muted">{t('skipped')}: {search.skipped.oversize + search.skipped.unsupported + search.skipped.invalidEncoding}</p></div>}
    <div className="bio-files" role="list">{page.value?.items.map(entry => <button role="listitem" key={entry.id} className={`bio-file ${selected?.id === entry.id ? 'is-active' : ''}`} onClick={() => { if (entry.kind === 'directory') onDirectory(entry.relativePath); else setSelected(entry) }}><span>{entry.kind === 'directory' ? '▸' : '◻'} {entry.name}</span><small>{entry.kind === 'file' ? `${Math.round(entry.size / 1024)} KB` : t('directory')}</small></button>)}</div>
    <div className="bio-row">{cursor && <Button variant="ghost" size="sm" onClick={() => { setSelected(undefined); setCursor(undefined) }}>{t('firstPage')}</Button>}{page.value?.nextCursor && <Button variant="ghost" size="sm" onClick={() => { setSelected(undefined); setCursor(page.value?.nextCursor) }}>{t('nextPage')}</Button>}</div>
    {selected && page.value && <MaterialFile key={`${root.id}:${relativeDir}:${page.value.generation}:${selected.id}`} root={root} relativeDir={relativeDir} generation={page.value.generation} entry={selected} writable={writable} />}
  </section>
}
function MaterialFile({ root, relativeDir, generation, entry, writable }: { root: MaterialRoot; relativeDir: string; generation: number; entry: MaterialEntry; writable: boolean }) {
  const { host, account } = useBio(), t = useBioT(), action = useAction(), [frame, setFrame] = useState(0), [preview, setPreview] = useState<MaterialImageResult>(), [url, setUrl] = useState(''), [sessionId, setSessionId] = useState(''), [status, setStatus] = useState('')
  const file = { rootId: root.id, relativeDir, generation, fileId: entry.id }
  const metadata = useResource(() => host.research.getMaterialImage({ ...file, kind: 'metadata', frameIndex: 0 }), [entry.id])
  const note = useResource(() => host.research.getMaterialAnnotation(file), [entry.id])
  const [sessionCursor, setSessionCursor] = useState<string>()
  const sessions = useResource(() => host.research.listSessions({ scope: root.scope, pageSize: 100, ...(sessionCursor ? { cursor: sessionCursor } : {}) }), [root.id, sessionCursor])
  const live = useRef(true), objectUrl = useRef(''), request = useRef(0)
  useEffect(() => { live.current = true; return () => { live.current = false; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current) } }, [])
  async function showFrame(index: number) {
    const id = ++request.current
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; setUrl(''); setPreview(undefined); setFrame(index)
    const result = await host.research.getMaterialImage({ ...file, kind: 'view', frameIndex: index })
    if (!live.current || request.current !== id) return
    setPreview(result)
    if (result.status === 'ok' && result.bytes) { const value = URL.createObjectURL(new Blob([Uint8Array.from(result.bytes)], { type: 'image/png' })); objectUrl.current = value; setUrl(value) }
  }
  const pages = metadata.value?.status === 'ok' ? metadata.value.pages : 0
  return <section className="bio-card"><h3>{entry.name}</h3><Tag value="restricted" /><ErrorNotice error={metadata.error || note.error || sessions.error || action.error} />
    {metadata.value && <p className="bio-muted">{metadata.value.status === 'ok' ? `${metadata.value.width} × ${metadata.value.height} · ${pages} ${t('frames')}` : t(`status.${metadata.value.status}`)}</p>}
    {pages > 0 && <div className="bio-row"><Button size="sm" variant="outline" disabled={action.busy || frame === 0} onClick={() => { void action.act(() => showFrame(frame - 1)) }}>{t('previousFrame')}</Button><span>{frame + 1} / {pages}</span><Button size="sm" variant="outline" disabled={action.busy} onClick={() => { void action.act(() => showFrame(frame)) }}>{t('viewFrame')}</Button><Button size="sm" variant="outline" disabled={action.busy || frame + 1 >= pages} onClick={() => { void action.act(() => showFrame(frame + 1)) }}>{t('nextFrame')}</Button></div>}
    {preview && preview.status !== 'ok' && <p className="bio-warning">{t(`status.${preview.status}`)}</p>}{url && <img className="bio-material-image" src={url} alt={`${entry.name} · ${frame + 1}`} />}
    {writable && entry.name.toLowerCase().endsWith('.pdf') && <div className="bio-card"><p>{t('importPrivateMaterialPdf')}</p><div className="bio-row"><select value={sessionId} aria-label={t('targetSession')} onChange={event => setSessionId(event.target.value)}><option value="">{t('chooseSession')}</option>{sessions.value?.items.filter(session => session.ownerId === account.id).map(session => <option key={session.id} value={session.id}>{session.name}</option>)}</select><Button size="sm" variant="outline" disabled={!sessionId || action.busy} onClick={() => { void action.act(async () => { const session = await host.research.getSession({ sessionId }); const result = await host.research.importMaterialPdf({ ...file, sessionId, expectedRevision: session.revision }); if (live.current) setStatus(result.status === 'ok' ? 'imported' : `status.${result.status}`) }) }}>{t('importPdf')}</Button></div>{status && <p role="status">{t(status)}</p>}</div>}
    {writable && entry.name.toLowerCase().endsWith('.pdf') && <div className="bio-row">{sessionCursor && <Button size="sm" variant="ghost" onClick={() => { setSessionId(''); setSessionCursor(undefined) }}>{t('firstPage')}</Button>}{sessions.value?.nextCursor && <Button size="sm" variant="ghost" onClick={() => { setSessionId(''); setSessionCursor(sessions.value?.nextCursor) }}>{t('nextPage')}</Button>}</div>}
    {note.value && <MaterialNote key={`${generation}:${entry.id}:${note.value.revision}`} file={file} initial={note.value} writable={writable} onSaved={note.reload} />}
  </section>
}
function MaterialNote({ file, initial, writable, onSaved }: { file: { rootId: string; relativeDir: string; generation: number; fileId: string }; initial: MaterialAnnotation; writable: boolean; onSaved(): void }) {
  const { host } = useBio(), t = useBioT(), action = useAction()
  const draft = useDraft([file.rootId, file.relativeDir, String(file.generation), file.fileId, 'annotation'], JSON.stringify(materialNoteDraft(initial)))
  const value = materialNoteDraft(initial, draft.value)
  const update = (patch: Partial<typeof value>) => draft.set(JSON.stringify({ ...value, ...patch }))
  return <form className="bio-editor" onSubmit={event => { event.preventDefault(); void action.act(async () => { await host.research.saveMaterialAnnotation({ ...file, ...materialNoteContent(value) }); draft.clear(); onSaved() }) }}>
    <Button type="button" size="sm" variant="ghost" onClick={onSaved}>{t('refreshNote')}</Button>
    {value.baseRevision !== initial.revision && <div className="bio-warning"><p>{t('noteConflict')}</p><details><summary>{t('latestSavedNote')}</summary><p>{initial.note}</p><p>{initial.tags.join(', ')}</p></details>{writable && <Button type="button" size="sm" variant="outline" onClick={() => update({ baseRevision: initial.revision })}>{t('mergeNoteBase')}</Button>}<Button type="button" size="sm" variant="ghost" onClick={() => draft.set(JSON.stringify(materialNoteDraft(initial)))}>{t('discardNoteDraft')}</Button></div>}
    <Field label={t('privateNote')}><Textarea aria-label={t('privateNote')} value={value.note} disabled={!writable} maxLength={5000} onChange={event => update({ note: event.target.value })} /></Field><Field label={t('tags')}><Input aria-label={t('tags')} value={value.tagText} disabled={!writable} maxLength={2000} onChange={event => update({ tagText: event.target.value })} /></Field><ErrorNotice error={action.error || draft.error} />{writable && <Button size="sm" disabled={action.busy}>{t('saveNote')}</Button>}
  </form>
}
