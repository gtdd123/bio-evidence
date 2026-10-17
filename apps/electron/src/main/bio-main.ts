import './bio-bootstrap.mjs'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { ArtifactExportSchema, ImportPdfRequestSchema, BIO_ERROR_MESSAGES, ResearchError, RESEARCH_CHANNELS } from '@bio-evidence/research-core'
import { resolveConfigDir, validateNamespacePath } from '@craft-agent/shared/config/namespace'
import { validatedAuthOrigin } from '@craft-agent/shared/auth/bio-client'
import { BioClientController } from '../transport/bio-client'
import { desktopBioAuthDriver } from './bio-desktop-auth'
import { assertBioWindowSender } from './bio-window-access'

const rendererPath = join(__dirname, 'renderer', 'bio.html'), rendererUrl = pathToFileURL(rendererPath).href
const originFile = () => validateNamespacePath(join(resolveConfigDir(), 'bio-desktop.json'))
function savedOrigin() {
  try { const path = originFile(); if (!existsSync(path) || statSync(path).size > 4096) return ''; return validatedAuthOrigin(z.strictObject({ origin: z.string() }).parse(JSON.parse(readFileSync(path, 'utf8'))).origin) } catch { return '' }
}
const owners = new Map<number, { window: BrowserWindow; client: BioClientController }>()
function owner(event: IpcMainInvokeEvent) {
  const entry = owners.get(event.sender.id); assertBioWindowSender(entry?.window, event, rendererUrl); return entry!
}
function handle(channel: string, work: (entry: ReturnType<typeof owner>, input: unknown) => unknown) {
  ipcMain.handle(channel, async (event, input) => {
    try { const entry = owner(event), epoch = entry.client.state.epoch, result = await work(entry, input)
      owner(event)
      if (!['bio:login', 'bio:logout', 'bio:current'].includes(channel) && epoch !== entry.client.state.epoch) throw new ResearchError('BIO_ACCESS_DENIED')
      return { ok: true, result }
    } catch (error) { const code = (error as { code?: string })?.code; return { ok: false, errorCode: code && Object.hasOwn(BIO_ERROR_MESSAGES, code) ? code : 'BIO_INPUT_INVALID' } }
  })
}
handle('bio:current', entry => entry.client.current())
handle('bio:login', async (entry, raw) => {
  const input = z.strictObject({ origin: z.string().max(2000), username: z.string().min(3).max(64), password: z.string().min(1).max(1024) }).parse(raw)
  const state = await entry.client.login(input.origin, input.username, input.password)
  if (state.account) writeFileSync(originFile(), JSON.stringify({ origin: state.origin }), { mode: 0o600 })
  return state
})
handle('bio:logout', entry => entry.client.logout())
handle('bio:invoke', (entry, raw) => {
  const input = z.strictObject({ channel: z.string().max(100), args: z.tuple([z.unknown()]) }).parse(raw)
  return entry.client.invoke(input.channel, ...input.args)
})
handle('bio:importPdf', async (entry, raw) => {
  const input = ImportPdfRequestSchema.parse(raw), before = entry.client.state
  if (!before.account || before.status !== 'connected') throw new ResearchError('BIO_ACCESS_DENIED')
  const selected = await dialog.showOpenDialog(entry.window, { properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
  if (selected.canceled || !selected.filePaths[0]) return { status: 'cancelled' }
  const file = await open(selected.filePaths[0], 'r')
  let bytes: Uint8Array
  try {
    const stats = await file.stat(); if (!stats.isFile()) return { status: 'invalid' }
    if (stats.size > 25 * 1024 * 1024) return { status: 'budget' }
    const buffer = Buffer.alloc(stats.size + 1); let offset = 0
    while (offset < buffer.length) { const result = await file.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead }
    if (offset !== stats.size) return { status: 'invalid' }
    bytes = buffer.subarray(0, offset)
  } finally { await file.close() }
  if (before.epoch !== entry.client.state.epoch) throw new ResearchError('BIO_ACCESS_DENIED')
  return entry.client.importPdf(input, bytes)
})
handle('bio:saveExport', async (entry, raw) => {
  const value = ArtifactExportSchema.parse(raw), before = entry.client.state
  if (!before.account || before.status !== 'connected') throw new ResearchError('BIO_ACCESS_DENIED')
  const selected = await dialog.showSaveDialog(entry.window, { defaultPath: value.filename, filters: [{ name: value.format === 'csv' ? 'CSV' : 'Markdown', extensions: [value.format === 'csv' ? 'csv' : 'md'] }] })
  if (selected.canceled || !selected.filePath) return { saved: false }
  if (entry.window.isDestroyed() || before.epoch !== entry.client.state.epoch) throw new ResearchError('BIO_ACCESS_DENIED')
  await writeFile(selected.filePath, value.content, { encoding: 'utf8', mode: 0o600 }); return { saved: true }
})
export async function createBioWindow() {
  const window = new BrowserWindow({ width: 1360, height: 900, minWidth: 900, minHeight: 650, title: 'BioEvidence', backgroundColor: '#f6f7f9',
    webPreferences: { preload: join(__dirname, 'bio-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
  const client = new BioClientController(desktopBioAuthDriver, savedOrigin())
  const senderId = window.webContents.id
  owners.set(senderId, { window, client })
  const emit = (channel: string, value: unknown) => { if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.getURL() === rendererUrl) window.webContents.send(channel, value) }
  client.onState(state => emit('bio:state', state)); client.on(RESEARCH_CHANNELS.EVENT, event => emit('bio:event', event))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.on('closed', () => { owners.delete(senderId); client.dispose() })
  window.setMenu(null); await window.loadFile(rendererPath); return window
}
app.whenReady().then(createBioWindow).catch(() => { app.exit(1) })
app.on('window-all-closed', () => app.quit())
