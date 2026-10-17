import { expect, test } from 'bun:test'
import { createDesktopBioHost } from './desktop-host'
import { ResearchRequestSchemas } from '@bio-evidence/research-core'
import type { BioDesktopWireHost } from '../../shared/bio-api'
test('renderer rebuilds typed failures from plain bridge DTOs instead of relying on Error properties crossing Electron', async () => {
  const research = Object.fromEntries(Object.keys(ResearchRequestSchemas).map(channel => [channel.slice('research:v1:'.length), async () => ({ ok: false, errorCode: 'BIO_REVISION_CONFLICT' })]))
  const wire = { platform: 'desktop', research: { ...research, onEvent: () => () => {} }, onState: () => () => {},
    account: { current: async () => ({ ok: true, result: { status: 'signed-out' } }), login: async () => ({ ok: false, errorCode: 'BIO_ACCESS_DENIED' }), logout: async () => ({ ok: true, result: undefined }) },
    importPdf: async () => { throw Error('Synthetic private native path') }, saveExport: async () => ({ ok: false, errorCode: 'forged-code-and-private-body' }),
  } as unknown as BioDesktopWireHost
  const host = createDesktopBioHost(wire)
  expect((await host.account.current()).status).toBe('signed-out')
  await expect(host.research.listSpaces({})).rejects.toMatchObject({ code: 'BIO_REVISION_CONFLICT' })
  await expect(host.account.login('http://127.0.0.1', 'alice', 'synthetic')).rejects.toMatchObject({ code: 'BIO_ACCESS_DENIED' })
  await expect(host.importPdf({ sessionId: 'session', expectedRevision: 1, declaredPublic: false })).rejects.toMatchObject({ code: 'BIO_STORAGE_UNAVAILABLE', message: 'Research storage is unavailable.' })
  await expect(host.saveExport({} as any)).rejects.toMatchObject({ code: 'BIO_STORAGE_UNAVAILABLE' })
  await host.account.logout()
})
