import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { join, relative, sep, isAbsolute } from 'node:path'
import { resolveConfigDir, buildNamespaceEnv } from '@craft-agent/shared/config/namespace'
import { SqliteResearchRepository } from './sqlite-repository'
import { BioAuthService } from './auth-service'
import { AuthBoundary } from './auth-http'
import { createBioAuthNodeAdapter } from './auth-node'
describe('bounded Node auth request lifecycle', () => {
  let repo: SqliteResearchRepository, server: Server, origin: string, root: string
  beforeEach(async () => {
    root = mkdtempSync(join(resolveConfigDir(), 't06-http-stream-')); origin = 'http://127.0.0.1:0'
    repo = new SqliteResearchRepository(); const auth = await BioAuthService.create(repo)
    const boundary = new AuthBoundary(() => origin ?? 'http://127.0.0.1:0')
    server = createServer(createBioAuthNodeAdapter(auth, boundary, { bodyDeadlineMs: 80 }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Owned HTTP address')
    origin = `http://127.0.0.1:${address.port}`
  })
  afterEach(() => {
    server.closeAllConnections(); server.close(); repo.close()
    const offset = relative(realpathSync.native(resolveConfigDir()), realpathSync.native(root))
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned stream cleanup boundary')
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
  async function unfinished(path: string, method = 'POST') {
    const node = Bun.which('node'); if (!node) throw Error('Native stream verification requires Node')
    const fixture = join(root, 'native-slow-request.cjs')
    writeFileSync(fixture, `const http=require('node:http');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const {origin,path,method}=JSON.parse(input);let writes=0,done=false;
const req=http.request(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},res=>{res.resume();finish(res.statusCode)});
const pulse=setInterval(()=>{writes++;req.write('x')},10);const watchdog=setTimeout(()=>finish(0),500);
function finish(status){if(done)return;done=true;clearInterval(pulse);clearTimeout(watchdog);req.destroy();console.log(JSON.stringify({status,writes}))}
req.on('error',()=>{});req.flushHeaders();req.write('{"username":"');
});`)
    const child = Bun.spawn([node, fixture], { env: buildNamespaceEnv(process.env), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    child.stdin.write(JSON.stringify({ origin, path, method })); child.stdin.end()
    try {
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code).toBe(0); return JSON.parse(stdout) as { status: number; writes: number }
    } finally { child.kill('SIGKILL'); await child.exited }
  }
  test('continuous small chunks cannot extend the absolute body deadline', async () => {
    const result = await unfinished('/api/auth/login')
    expect(result.status).toBe(400); expect(result.writes >= 2).toBe(true)
  })
  test('unknown routes and wrong methods are refused before consuming unfinished bodies', async () => {
    expect((await unfinished('/unknown')).status).toBe(404)
    expect((await unfinished('/api/auth/login', 'PUT')).status).toBe(405)
  })
})
