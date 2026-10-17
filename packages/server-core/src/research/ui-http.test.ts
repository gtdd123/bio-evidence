import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { SqliteResearchRepository } from './sqlite-repository'
import { createBioAuthorityServer } from './authority-server'
import { createBioUiHttpAdapter } from './ui-http'

test('same-port research UI serves only manifest assets and config requires an account', async () => {
  mkdirSync(resolve('.fixtures'), { recursive: true })
  const root = mkdtempSync(resolve('.fixtures/t15-ui-')), repo = new SqliteResearchRepository()
  let handler: ((request: any, response: any) => boolean) | undefined
  const instance = await createBioAuthorityServer(repo, { port: 0, additionalHttpHandler: (req, res) => handler?.(req, res) ?? false })
  try {
    const html = '<!doctype html><meta name="bio-evidence" content="1"><div id="root">BioEvidence</div>', asset = 'console.log("synthetic UI")'
    mkdirSync(join(root, 'assets')); writeFileSync(join(root, 'index.html'), html); writeFileSync(join(root, 'assets/app.js'), asset)
    writeFileSync(join(root, 'service.json'), 'DO-NOT-SERVE-SYNTHETIC-SECRET')
    writeFileSync(join(root, 'bio-ui.json'), JSON.stringify({ product: 'BioEvidence', version: 1, files: [{ path: 'index.html', sha256: createHash('sha256').update(html).digest('hex') }, { path: 'assets/app.js', sha256: createHash('sha256').update(asset).digest('hex') }] }))
    handler = createBioUiHttpAdapter(instance.auth, instance.boundary, root)
    await instance.auth.createAccount(null, 'admin', 'Synthetic-ui-passphrase-123!', true)
    await instance.server.listen(); const origin = instance.boundary.publicOrigin
    const index = await fetch(origin + '/')
    expect(index.status).toBe(200); expect(await index.text()).toBe(html)
    expect(index.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(index.headers.get('cache-control')).toBe('no-store')
    expect(await (await fetch(origin + '/login')).text()).toBe(html)
    expect((await fetch(origin + '/api/config')).status).toBe(401)
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Synthetic-ui-passphrase-123!' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const config = await fetch(origin + '/api/config', { headers: { cookie } })
    expect(config.status).toBe(200); expect(await config.json()).toEqual({ product: 'BioEvidence', protocolVersion: 1, wsUrl: origin.replace('http:', 'ws:') })
    expect((await fetch(origin + '/api/config', { headers: { cookie, Origin: 'https://other.invalid' } })).status).toBe(403)
    expect((await fetch(origin + '/assets/app.js')).headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    for (const path of ['/service.json', '/bio-ui.json', '/assets/app.js.map', '/assets/../service.json', '/assets/%2e%2e%2fservice.json']) expect((await fetch(origin + path)).status).toBe(404)
    expect((await fetch(origin + '/', { method: 'POST' })).status).toBe(405)
    // Files changing after adapter construction cannot become a new executable asset.
    writeFileSync(join(root, 'assets/app.js'), 'modified')
    const changed = await fetch(origin + '/assets/app.js')
    expect(changed.status === 503 || await changed.text() === asset).toBe(true)
  } finally {
    instance.server.close(); repo.close()
    const offset = relative(realpathSync.native(resolve('.fixtures')), realpathSync.native(root))
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned fixture boundary')
    rmSync(root, { recursive: true, force: true })
  }
})
