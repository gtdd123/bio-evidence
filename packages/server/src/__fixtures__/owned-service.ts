import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { buildNamespaceEnv, resolveConfigDir } from '@craft-agent/shared/config/namespace.mjs'

export async function startOwnedService(name: string, seed?: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(resolveConfigDir(), name + '-'))
  const probe = createServer()
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(done => probe.close(() => done()))
  writeFileSync(join(root, 'service.json'), JSON.stringify({ port }))
  await seed?.(root)
  const env = buildNamespaceEnv({ ...process.env, BIOEVIDENCE_CONFIG_DIR: root, CRAFT_CONFIG_DIR: root })
  const proc = Bun.spawn([process.execPath, 'run', `--config=${resolve('scripts/bunfig.bio-bootstrap.toml')}`, resolve('packages/server/src/bio-index.ts'), '--control-stdio'], { env, cwd: resolve('.'), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  let ready!: () => void, reject!: (reason: unknown) => void
  const started = new Promise<void>((yes, no) => { ready = yes; reject = no })
  const output = (async () => {
    let text = ''
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      text += new TextDecoder().decode(chunk)
      if (text.length > 100000) throw Error('Service output exceeded test budget')
      if (text.includes('BioEvidence account service:')) ready()
    }
    reject(Error('Service exited before readiness'))
    return text
  })()
  const errors = new Response(proc.stderr).text()
  const timer = setTimeout(() => reject(Error('Owned service startup timeout')), 10000)
  try { await started } catch (error) { proc.kill(); await proc.exited; await output.catch(() => {}); await errors; throw error } finally { clearTimeout(timer) }
  return { proc, root, output, errors, origin: `http://127.0.0.1:${port}` }
}
export async function exitWithin(proc: ReturnType<typeof Bun.spawn>, timeout = 3000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([proc.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Controlled shutdown did not finish')), timeout) })]) }
  finally { if (timer) clearTimeout(timer) }
}
