import { expect, test } from 'bun:test'
import { readBioJson, uploadBioPdf } from './bio-http'
test('HTTP transport preserves fixed policy and revision errors instead of collapsing every 403 into access denial', async () => {
  await expect(readBioJson(Response.json({ error: 'BIO_POLICY_DENIED' }, { status: 403 }))).rejects.toMatchObject({ code: 'BIO_POLICY_DENIED' })
  await expect(readBioJson(Response.json({ error: 'BIO_REVISION_CONFLICT' }, { status: 409 }))).rejects.toMatchObject({ code: 'BIO_REVISION_CONFLICT' })
  await expect(readBioJson(Response.json({ error: 'Synthetic private native path' }, { status: 503 }))).rejects.toMatchObject({ code: 'BIO_STORAGE_UNAVAILABLE', message: 'Research storage is unavailable.' })
})
test('PDF budget and parse failures retain their structured status on non-2xx HTTP responses', async () => {
  const previous = globalThis.fetch
  try {
    globalThis.fetch = (async () => Response.json({ status: 'budget' }, { status: 413 })) as unknown as typeof fetch
    expect(await uploadBioPdf('http://127.0.0.1:9100', { sessionId: 'session', expectedRevision: 1, declaredPublic: false }, new Uint8Array([1]))).toEqual({ status: 'budget' })
  } finally { globalThis.fetch = previous }
})
