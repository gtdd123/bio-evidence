import { BIO_ERROR_MESSAGES, ResearchError, ResearchRequestSchemas } from '@bio-evidence/research-core'
import type { BioHostApi, BioDesktopWireHost, ResearchClientApi } from '../../shared/bio-api'
function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === 'object') {
    const value = raw as { ok?: unknown; result?: unknown; errorCode?: unknown }
    if (value.ok === true) return value.result
    if (value.ok === false && typeof value.errorCode === 'string' && Object.hasOwn(BIO_ERROR_MESSAGES, value.errorCode)) throw new ResearchError(value.errorCode as keyof typeof BIO_ERROR_MESSAGES)
  }
  throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
}
function method(source: (...args: any[]) => Promise<unknown>) {
  return async (...args: any[]) => {
    let raw: unknown
    try { raw = await source(...args) } catch { throw new ResearchError('BIO_STORAGE_UNAVAILABLE') }
    return unwrap(raw)
  }
}
/** Runs in the renderer so structured error codes survive the isolated bridge. */
export function createDesktopBioHost(wire: BioDesktopWireHost): BioHostApi {
  const research = { onEvent: wire.research.onEvent } as ResearchClientApi
  for (const channel of Object.keys(ResearchRequestSchemas)) {
    const name = channel.slice('research:v1:'.length) as Exclude<keyof ResearchClientApi, 'onEvent'>
    ;(research as unknown as Record<string, unknown>)[name] = method(wire.research[name] as (...args: any[]) => Promise<unknown>)
  }
  return { platform: 'desktop', research,
    account: { current: method(wire.account.current), login: method(wire.account.login), logout: method(wire.account.logout) } as BioHostApi['account'],
    onState: wire.onState, importPdf: method(wire.importPdf) as BioHostApi['importPdf'], saveExport: method(wire.saveExport) as BioHostApi['saveExport'],
  }
}
