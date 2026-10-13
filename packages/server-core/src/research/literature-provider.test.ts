import { describe, expect, test } from 'bun:test'
import { EuropePmcProvider, LiteratureProviderError } from './literature-provider'

const publicDns = async () => [{ address: '193.62.193.80', family: 4 }]
const article = { id: '37794110', source: 'MED', pmid: '37794110', pmcid: 'PMC10551030', doi: '10.1038/s41597-023-02540-1', title: 'Synthetic public title', pubYear: '2023', abstractText: 'Synthetic public abstract', authorList: { author: [{ fullName: 'Synthetic Author' }] }, isOpenAccess: 'Y' }
function json(result: unknown[], nextCursorMark?: string): Response {
  return Response.json({ hitCount: result.length, resultList: { result }, ...(nextCursorMark ? { nextCursorMark } : {}) })
}
function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init: RequestInit = {}) => handler(new URL(String(input)), init)) as typeof fetch
}
async function reason(task: Promise<unknown>): Promise<string> {
  try { await task; return 'unexpected-success' } catch (error) {
    expect(error instanceof LiteratureProviderError).toBe(true)
    return (error as LiteratureProviderError).reason
  }
}
describe('fixed public Europe PMC provider', () => {
  test('rejects private DNS, malformed IDs and unexpected redirects before consuming content', async () => {
    let calls = 0
    const fetcher = fakeFetch(() => { calls++; return json([]) })
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) {
      const provider = new EuropePmcProvider({ resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }], fetch: fetcher })
      expect(await reason(provider.search({ query: 'public' }))).toBe('unavailable')
    }
    const provider = new EuropePmcProvider({ resolve: publicDns, fetch: fetcher })
    expect(await reason(provider.openText({ pmcid: '../private' }))).toBe('invalid')
    expect(await reason(provider.record({ providerId: 'MED:1 OR secret' }))).toBe('invalid')
    expect(calls).toBe(0)
    expect(await reason(new EuropePmcProvider({ resolve: publicDns, fetch: fakeFetch(() => new Response('', { status: 302 })) }).search({ query: 'public' }))).toBe('unavailable')
  })
  test('bounds response bytes, deadline, cancellation and rate-limit errors', async () => {
    expect(await reason(new EuropePmcProvider({ resolve: publicDns, maxBytes: 32, fetch: fakeFetch(() => json([article])) }).search({ query: 'public' }))).toBe('budget')
    expect(await reason(new EuropePmcProvider({ resolve: publicDns, timeoutMs: 20, fetch: fakeFetch(() => new Promise(() => {})) }).search({ query: 'public' }))).toBe('timeout')
    const abort = new AbortController(); abort.abort()
    expect(await reason(new EuropePmcProvider({ resolve: publicDns, fetch: fakeFetch(() => json([])) }).search({ query: 'public', signal: abort.signal }))).toBe('cancelled')
    expect(await reason(new EuropePmcProvider({ resolve: publicDns, fetch: fakeFetch(() => new Response('', { status: 429, headers: { 'retry-after': '30' } })) }).search({ query: 'public' }))).toBe('rate-limited')
  })
  test('uses core search with encoded query, provider cursor and trustworthy metadata', async () => {
    let requested: URL | undefined
    const provider = new EuropePmcProvider({ resolve: publicDns, fetch: fakeFetch((url, init) => {
      requested = url; expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit')
      return json([article], 'opaque+/next=')
    }) })
    const result = await provider.search({ query: 'EXT_ID:37794110 AND SRC:MED', cursor: '*', pageSize: 1 })
    expect(requested!.origin).toBe('https://www.ebi.ac.uk')
    expect(requested!.pathname).toBe('/europepmc/webservices/rest/search')
    expect(requested!.searchParams.get('resultType')).toBe('core')
    expect(requested!.searchParams.get('query')).toBe('EXT_ID:37794110 AND SRC:MED')
    expect(result.items[0]).toEqual({ provider: 'europe-pmc', providerId: 'MED:37794110', identifiers: { providerId: 'MED:37794110', pmid: '37794110', pmcid: 'PMC10551030', doi: '10.1038/s41597-023-02540-1' }, title: 'Synthetic public title', year: 2023, abstract: 'Synthetic public abstract', authors: ['Synthetic Author'], license: { status: 'unknown' }, availability: { abstract: true, fullText: true } })
    expect(result.nextCursor).toBe('opaque+/next=')
  })
  test('does not fabricate missing fields and empty search stays empty', async () => {
    const provider = new EuropePmcProvider({ resolve: publicDns, fetch: fakeFetch(() => json([{ id: 'missing', source: 'AGR' }])) })
    const item = (await provider.search({ query: 'synthetic' })).items[0]!
    for (const field of ['title', 'authors', 'year', 'abstract']) expect(field in item).toBe(false)
    expect(item.identifiers).toEqual({ providerId: 'AGR:missing' })
    expect(item.availability).toEqual({ abstract: false, fullText: false })
    const empty = new EuropePmcProvider({ resolve: publicDns, fetch: fakeFetch(() => json([], '*')) })
    expect(await empty.search({ query: 'no results' })).toEqual({ items: [] })
  })
  test('record resolves exact provider identity and XML stays raw until the parser stage', async () => {
    const paths: string[] = []
    const xml = '<article><body>synthetic public XML</body></article>'
    const provider = new EuropePmcProvider({ resolve: publicDns, fetch: fakeFetch(url => {
      paths.push(url.pathname)
      return url.pathname.endsWith('/fullTextXML') ? new Response(xml, { headers: { 'content-type': 'application/xml' } }) : json([article])
    }) })
    expect((await provider.record({ providerId: 'MED:37794110' })).providerId).toBe('MED:37794110')
    expect(new TextDecoder().decode(await provider.openText({ pmcid: 'PMC10551030' }))).toBe(xml)
    expect(paths[1]).toBe('/europepmc/webservices/rest/PMC10551030/fullTextXML')
  })
})
