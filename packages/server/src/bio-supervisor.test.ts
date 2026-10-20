import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const node = Bun.which('node')
if (!node) throw Error('Supervisor verification requires the existing Node runtime')
function isAlive(pid: number) { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }

async function start(trackStop = false, hang = false) {
  const proc = Bun.spawn([node!, resolve('packages/server/src/__fixtures__/supervised-service.mjs'), ...(trackStop ? ['--track-stop'] : []), ...(hang ? ['--hang'] : [])], { cwd: resolve('.'), env: process.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  let ready!: () => void, fail!: (error: unknown) => void, childPid = 0, stateRoot = ''
  const started = new Promise<void>((yes, no) => { ready = yes; fail = no })
  const output = (async () => {
    let text = ''
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      text += new TextDecoder().decode(chunk)
      if (text.length > 100000) throw Error('Supervisor output exceeded budget')
      childPid = Number(text.match(/BIOEVIDENCE_TEST_CHILD_PID=(\d+)/)?.[1] ?? 0)
      const root = text.match(/BIOEVIDENCE_TEST_ROOT=(.+)\n/); if (root) stateRoot = JSON.parse(root[1]!)
      if (text.includes('BioEvidence account service:')) ready()
    }
    fail(Error('Supervisor exited before readiness')); return text
  })()
  const errors = new Response(proc.stderr).text()
  const timer = setTimeout(() => fail(Error('Supervisor startup timeout')), 10000)
  try { await started } catch (error) { if (proc.exitCode === null) proc.kill(); await proc.exited; await output.catch(() => {}); await errors; throw error } finally { clearTimeout(timer) }
  return { proc, output, errors, childAlive: () => !!childPid && isAlive(childPid), proof: () => join(stateRoot, 'shutdown-proof.json'), cleanup: async () => {
    if (proc.exitCode === null) proc.kill()
    await proc.exited; await errors
  } }
}
async function bounded<T>(promise: Promise<T>, timeout = 6000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Owned child did not exit')), timeout) })]) }
  finally { if (timer) clearTimeout(timer) }
}
test('Node supervisor relays only its owned service control pipe and exits with its child status', async () => {
  const owner = await start()
  try {
    // Stay alive beyond the child's five-second supervisor lease.
    await new Promise(resolve => setTimeout(resolve, 5500))
    ;(owner.proc.stdin as Bun.FileSink).write('{"type":"shutdown"}\n'); await (owner.proc.stdin as Bun.FileSink).flush()
    expect(await bounded(owner.proc.exited)).toBe(0)
    expect(await bounded(owner.output)).toContain('BIOEVIDENCE_STOPPED=0')
  } finally { await owner.cleanup() }
}, 20000)

for (const path of ['shutdown', 'eof']) test(`supervisor marks a hung child forced termination as failure after controlled ${path}`, async () => {
  const owner = await start(false, true)
  try {
    if (path === 'shutdown') { (owner.proc.stdin as Bun.FileSink).write('{"type":"shutdown"}\n'); await (owner.proc.stdin as Bun.FileSink).flush() }
    else (owner.proc.stdin as Bun.FileSink).end()
    const code = await bounded(owner.proc.exited, 18000)
    expect(code).toBe(1)
    expect(await owner.output).not.toContain('BIOEVIDENCE_STOPPED=0')
    expect(owner.childAlive()).toBe(false)
  } finally { await owner.cleanup() }
}, 25000)
test('abrupt supervisor death closes the pipe and the real child flushes instead of staying orphaned', async () => {
  const owner = await start(true)
  try {
    const terminate = Bun.spawn([node!, '-e', 'process.kill(Number(process.argv[1]), "SIGKILL")', String(owner.proc.pid)], { env: process.env, stdout: 'ignore', stderr: 'pipe' })
    expect(await terminate.exited).toBe(0); await owner.proc.exited
    const deadline = Date.now() + 8000
    while (!existsSync(owner.proof()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(existsSync(owner.proof())).toBe(true)
    expect(JSON.parse(readFileSync(owner.proof(), 'utf8'))).toMatchObject({ complete: true, code: 1 })
    while (owner.childAlive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(owner.childAlive()).toBe(false)
  } finally { await owner.cleanup() }
}, 20000)
