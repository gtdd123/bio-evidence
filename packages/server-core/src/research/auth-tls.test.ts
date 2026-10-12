import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep, isAbsolute } from 'node:path'
import { resolveConfigDir, buildNamespaceEnv } from '@craft-agent/shared/config/namespace'
import { SqliteResearchRepository } from './sqlite-repository'
import { createBioAuthorityServer } from './authority-server'

describe('native Node TLS verification for BioEvidence', () => {
  let root: string, repo: SqliteResearchRepository | undefined, instance: Awaited<ReturnType<typeof createBioAuthorityServer>> | undefined
  beforeEach(() => { root = mkdtempSync(join(resolveConfigDir(), 't06-tls-')) })
  afterEach(() => {
    instance?.server.close(); instance = undefined; repo?.close(); repo = undefined
    const offset = relative(realpathSync.native(resolveConfigDir()), realpathSync.native(root))
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned TLS cleanup boundary')
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
  test('untrusted certificate is rejected; explicit test CA permits HTTPS and authenticated WSS', async () => {
    const git = Bun.which('git')
    const candidate = git ? join(dirname(git), '..', 'usr', 'bin', 'openssl.exe') : ''
    const openssl = Bun.which('openssl') ?? (existsSync(candidate) ? candidate : null)
    const node = Bun.which('node')
    if (!openssl || !node) throw Error('TLS verification requires installed OpenSSL and Node')
    const cert = join(root, 'synthetic-localhost.pem'), key = join(root, 'synthetic-localhost-key.pem')
    const config = join(root, 'synthetic-openssl.cnf')
    writeFileSync(config, '[ req ]\ndistinguished_name=dn\nprompt=no\n[ dn ]\nCN=localhost\n')
    const generation = Bun.spawn([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-config', config, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], {
      env: buildNamespaceEnv(process.env), stdout: 'ignore', stderr: 'pipe',
    })
    const [code] = await Promise.all([generation.exited, new Response(generation.stderr).text()])
    expect(code).toBe(0)
    repo = new SqliteResearchRepository()
    instance = await createBioAuthorityServer(repo, { port: 0, tls: { cert: readFileSync(cert), key: readFileSync(key) } })
    await instance.auth.createAccount(null, 'admin', 'Synthetic-passphrase-9!', true)
    const login = await instance.auth.login('admin', 'Synthetic-passphrase-9!'); await instance.server.listen()
    const fixture = join(root, 'native-tls-check.cjs')
    writeFileSync(fixture, `const https=require('node:https'); const fs=require('node:fs'); const WebSocket=require('ws');
let input=''; process.stdin.on('data',x=>input+=x); process.stdin.on('end',async()=>{
const {origin,cert,token}=JSON.parse(input); const ca=fs.readFileSync(cert);
const untrusted=await new Promise(resolve=>{const r=https.get(origin+'/api/auth/session',res=>{res.resume();resolve(false)});r.on('error',e=>resolve(['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.code)))});
const trusted=await new Promise(resolve=>{const r=https.get(origin+'/api/auth/session',{ca,rejectUnauthorized:true},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});r.on('error',()=>resolve(0))});
const authenticated=await new Promise(resolve=>{const ws=new WebSocket(origin.replace('https:','wss:'),{ca,rejectUnauthorized:true});
const timeout=setTimeout(()=>{ws.terminate();resolve(false)},3000);ws.on('error',()=>{clearTimeout(timeout);resolve(false)});
ws.on('open',()=>ws.send(JSON.stringify({id:'tls-test',type:'handshake',protocolVersion:'1.0',token})));
ws.on('message',x=>{clearTimeout(timeout);resolve(JSON.parse(x).type==='handshake_ack');ws.close()})});
console.log(JSON.stringify({untrusted,trusted,authenticated}));
});`)
    const child = Bun.spawn([node, fixture], { env: buildNamespaceEnv(process.env), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    child.stdin.write(JSON.stringify({ origin: instance.boundary.publicOrigin, cert, token: login.token })); child.stdin.end()
    try {
      const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(exit).toBe(0); expect(JSON.parse(stdout)).toEqual({ untrusted: true, trusted: 401, authenticated: true })
    } finally { child.kill('SIGKILL'); await child.exited }
  }, 20000)
})
