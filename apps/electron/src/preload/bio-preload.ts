import { contextBridge, ipcRenderer } from 'electron'
import { buildClientApi } from '../transport/build-api'
import { RESEARCH_CHANNEL_MAP } from '../transport/research-channel-map'
import type { BioDesktopWireHost } from '../shared/bio-api'
import { BIO_ERROR_MESSAGES } from '@bio-evidence/research-core'
async function call(channel: string, input?: unknown) {
  try {
    const result = await ipcRenderer.invoke(channel, input)
    if (result?.ok === true) return { ok: true as const, result: result.result }
    return { ok: false as const, errorCode: typeof result?.errorCode === 'string' && Object.hasOwn(BIO_ERROR_MESSAGES, result.errorCode) ? result.errorCode : 'BIO_STORAGE_UNAVAILABLE' }
  } catch { return { ok: false as const, errorCode: 'BIO_STORAGE_UNAVAILABLE' } }
}
function listen(channel: 'bio:state' | 'bio:event', callback: (value: any) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value)
  ipcRenderer.on(channel, listener); return () => { ipcRenderer.removeListener(channel, listener) }
}
const research = buildClientApi({ invoke: (channel: string, ...args: unknown[]) => call('bio:invoke', { channel, args }), on: (_channel: string, callback: (event: unknown) => void) => listen('bio:event', callback) } as any, RESEARCH_CHANNEL_MAP).research as unknown as BioDesktopWireHost['research']
const host: BioDesktopWireHost = { platform: 'desktop', research,
  account: { current: () => call('bio:current'), login: (origin, username, password) => call('bio:login', { origin, username, password }), logout: () => call('bio:logout') },
  onState: callback => listen('bio:state', callback), importPdf: input => call('bio:importPdf', input), saveExport: value => call('bio:saveExport', value),
}
contextBridge.exposeInMainWorld('bioBridge', host)
