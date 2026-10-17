import { z } from 'zod'
import { ArtifactExportSchema, ResearchError } from '@bio-evidence/research-core'
import { createBrowserAuthClient } from '@craft-agent/shared/auth/bio-client'
import { WsRpcClient } from '../../../electron/src/transport/client'
import { BioClientController, type BioAuthorizedSession } from '../../../electron/src/transport/bio-client'
import { readBioJson, uploadBioPdf, BioCurrentAccountSchema } from '../../../electron/src/transport/bio-http'
import { buildClientApi } from '../../../electron/src/transport/build-api'
import { RESEARCH_CHANNEL_MAP } from '../../../electron/src/transport/research-channel-map'
import type { BioHostApi } from '../../../electron/src/shared/bio-api'
const Config = z.strictObject({ product: z.literal('BioEvidence'), protocolVersion: z.literal(1), wsUrl: z.string().url() })
export function createWebBioHost(): BioHostApi {
  const origin = window.location.origin, auth = createBrowserAuthClient(origin)
  const open = async (account: BioAuthorizedSession['account'], binding: string): Promise<BioAuthorizedSession> => {
    const headers = { 'X-Bio-Session-Binding': binding }
    const config = Config.parse(await readBioJson(await fetch(origin + '/api/config', { headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) }), 4096))
    if (config.wsUrl !== origin.replace(/^http/, 'ws')) throw new ResearchError('BIO_ACCESS_DENIED')
    const transport = new WsRpcClient(config.wsUrl + '/?bioBinding=' + encodeURIComponent(binding), { autoReconnect: true, mode: 'remote' })
    return { account, transport, current: async () => BioCurrentAccountSchema.parse(await auth.current(binding)).account, close: async revoke => { if (revoke) await auth.logout(binding) },
      importPdf: (input, bytes) => uploadBioPdf(origin, input, bytes, headers) }
  }
  const controller = new BioClientController({ restore: async () => { try { const current = await auth.current(); return await open(current.account, current.sessionBinding) } catch (error) { if ((error as { status?: number }).status === 401) return null; throw error } },
    login: async (value, username, password) => { if (value !== origin) throw new ResearchError('BIO_ACCESS_DENIED'); const current = await auth.login(username, password); return open(current.account, current.sessionBinding) } }, origin)
  const urls = new Set<string>(); let epoch = controller.state.epoch
  controller.onState(state => { if (epoch !== state.epoch || state.status !== 'connected') { for (const url of urls) URL.revokeObjectURL(url); urls.clear() }; epoch = state.epoch })
  const host: BioHostApi = { platform: 'web', research: buildClientApi(controller as any, RESEARCH_CHANNEL_MAP).research,
    account: { current: () => controller.current(), login: (...args) => controller.login(...args), logout: () => controller.logout() }, onState: cb => controller.onState(cb),
    importPdf: async input => {
      const before = controller.state
      const file = await new Promise<File | null>(resolve => {
        const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.pdf,application/pdf'
        picker.onchange = () => resolve(picker.files?.[0] ?? null); picker.oncancel = () => resolve(null); picker.click()
      })
      if (!file) return { status: 'cancelled' }
      if (file.size > 25 * 1024 * 1024) return { status: 'budget' }
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (before.epoch !== controller.state.epoch || before.account?.id !== controller.state.account?.id) throw new ResearchError('BIO_ACCESS_DENIED')
      return controller.importPdf(input, bytes)
    },
    saveExport: async raw => {
      const value = ArtifactExportSchema.parse(raw)
      const url = URL.createObjectURL(new Blob([value.content], { type: value.mediaType })); urls.add(url)
      const link = document.createElement('a'); link.href = url; link.download = value.filename; link.click()
      setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url) }, 1000)
      return { saved: true }
    },
  }
  window.addEventListener('pagehide', () => { controller.dispose(); for (const url of urls) URL.revokeObjectURL(url); urls.clear() }, { once: true })
  return host
}
