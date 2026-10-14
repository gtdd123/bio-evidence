import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { resolve, join, relative, sep, isAbsolute } from 'node:path'
import { DocumentParseService } from './document-parse'
function fixture(code: string) {
  mkdirSync(resolve('.runtime/checks'), { recursive: true })
  const root = mkdtempSync(resolve('.runtime/checks/t11-worker-')), worker = join(root, 'worker.ts')
  writeFileSync(worker, code)
  return { worker, cleanup: () => {
    const offset = relative(realpathSync.native(resolve('.runtime/checks')), realpathSync.native(root))
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw Error('Owned fixture boundary')
    rmSync(root, { recursive: true, force: true })
  } }
}
test('parser child receives binary bytes without file paths and validates coverage output', async () => {
  const script = fixture(`const chunks=[];for await(const part of process.stdin)chunks.push(part);const bytes=Buffer.concat(chunks),at=bytes.indexOf(10),cmd=JSON.parse(bytes.subarray(0,at).toString());
    if(cmd.format!=='pdf'||bytes.subarray(at+1).toString()!=='synthetic input')process.exit(1);
    process.stdout.write(JSON.stringify({status:'ok',format:'pdf',coverage:{level:'full',totalUnits:1,units:[{unit:1,status:'read'}]},blocks:[{id:'block1',unit:1,text:'Synthetic output',locator:{kind:'pdf-page',page:1}}]}));`)
  const parser = new DocumentParseService({ workerPath: script.worker })
  try { const result = await parser.parse(new TextEncoder().encode('synthetic input'), 'pdf'); expect(result.status).toBe('ok'); expect(parser.activeProcessIds).toHaveLength(0) }
  finally { await parser.close(); script.cleanup() }
})
test('timeout and cancel terminate the actual child; close prohibits new tasks', async () => {
  const script = fixture('setInterval(()=>{},1000)')
  const parser = new DocumentParseService({ workerPath: script.worker, timeoutMs: 200 }), controller = new AbortController()
  try {
    const timed = parser.parse(new Uint8Array([1]), 'pdf')
    const pid = parser.activeProcessIds[0]!
    expect(await timed).toEqual({ status: 'timeout' }); expect(() => process.kill(pid, 0)).toThrow()
    const cancelled = parser.parse(new Uint8Array([1]), 'jats', controller.signal), cancelPid = parser.activeProcessIds[0]!
    controller.abort(); expect(await cancelled).toEqual({ status: 'cancelled' }); expect(() => process.kill(cancelPid, 0)).toThrow()
    await parser.close(); expect(await parser.parse(new Uint8Array([1]), 'pdf')).toEqual({ status: 'unavailable' })
  } finally { controller.abort(); await parser.close(); script.cleanup() }
})
test('close kills an active parser and input/concurrency budgets prevent extra processes', async () => {
  const script = fixture('setInterval(()=>{},1000)'), parser = new DocumentParseService({ workerPath: script.worker, pdfMaxBytes: 1 })
  try {
    expect(await parser.parse(new Uint8Array([1, 2]), 'pdf')).toEqual({ status: 'budget' })
    const pending = parser.parse(new Uint8Array([1]), 'pdf'), pid = parser.activeProcessIds[0]!
    expect(await parser.parse(new Uint8Array([1]), 'pdf')).toEqual({ status: 'busy' })
    await parser.close(); expect(await pending).toEqual({ status: 'unavailable' }); expect(() => process.kill(pid, 0)).toThrow()
    expect(parser.activeProcessIds).toHaveLength(0)
  } finally { await parser.close(); script.cleanup() }
})
test('a child cannot claim a different format or unread blocks as complete coverage', async () => {
  const script = fixture(`for await(const chunk of process.stdin){};process.stdout.write(JSON.stringify({status:'ok',format:'pdf',coverage:{level:'full',totalUnits:1,units:[{unit:1,status:'read'}]},blocks:[{id:'bad',unit:1,text:'Synthetic',locator:{kind:'pdf-page',page:2}}]}))`)
  const parser = new DocumentParseService({ workerPath: script.worker })
  try { expect(await parser.parse(new Uint8Array([1]), 'pdf')).toEqual({ status: 'unavailable' }); expect(await parser.parse(new Uint8Array([1]), 'jats')).toEqual({ status: 'unavailable' }) }
  finally { await parser.close(); script.cleanup() }
})
