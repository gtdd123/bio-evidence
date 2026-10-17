import { loginDesktopAccount, validatedAuthOrigin } from '@craft-agent/shared/auth/bio-client'
import { WsRpcClient } from '../transport/client'
import type { BioAuthDriver } from '../transport/bio-client'
import { BioCurrentAccountSchema, readBioJson, uploadBioPdf } from '../transport/bio-http'
/** Bearers live only inside a main-process authorized-session closure. */
export const desktopBioAuthDriver: BioAuthDriver = {
  restore: async () => null,
  login: async (value, username, password) => {
    const origin = validatedAuthOrigin(value), login = await loginDesktopAccount(origin, username, password)
    const headers = { Authorization: `Bearer ${login.token}` }
    const transport = new WsRpcClient(origin.replace(/^http/, 'ws'), { token: login.token, autoReconnect: true, mode: 'remote' })
    return { account: login.account, transport,
      current: async () => BioCurrentAccountSchema.parse(await readBioJson(await fetch(origin + '/api/auth/session', { headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) }), 4096)).account,
      close: async revoke => { if (revoke) await readBioJson(await fetch(origin + '/api/auth/logout', { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(10000) }), 4096) },
      importPdf: (input, bytes) => uploadBioPdf(origin, input, bytes, headers),
    }
  },
}
