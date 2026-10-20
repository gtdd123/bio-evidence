import type { Readable } from 'node:stream'

/** Completion must not depend on a supervisor keeping the stdout pipe alive. */
export function finishOwnedShutdown(code: 0 | 1): void {
  const finish = () => process.exit(code)
  process.stdout.once('error', finish)
  const fallback = setTimeout(finish, 250)
  try { process.stdout.write(`BIOEVIDENCE_STOPPED=${code}\n`, () => { clearTimeout(fallback); finish() }) }
  catch { clearTimeout(fallback); finish() }
}

/** Local supervisor control only. Never connect this stream to an HTTP/RPC client. */
export function createOwnedShutdown(stop: () => Promise<void>, finish: (code: 0 | 1) => void, input?: Readable) {
  let closing: Promise<void> | undefined, buffer = ''
  let watchdog: ReturnType<typeof setTimeout> | undefined
  function heartbeat() { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => { void request(1) }, 5000) }
  function detach() { if (watchdog) clearTimeout(watchdog); input?.off('data', data); input?.off('end', eof); input?.off('error', eof); input?.pause() }
  function request(code: 0 | 1 = 0): Promise<void> {
    if (closing) return closing
    detach()
    closing = Promise.resolve().then(stop).then(() => finish(code), () => finish(1))
    return closing
  }
  function eof() { void request(1) }
  function data(chunk: Buffer | string) {
    buffer += chunk.toString()
    if (Buffer.byteLength(buffer) > 4096) { void request(1); return }
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline < 0) return
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      try {
        const command = JSON.parse(line)
        if (!command || typeof command !== 'object' || Object.keys(command).length !== 1) throw Error('Invalid supervisor frame')
        if (command.type === 'heartbeat') heartbeat()
        else if (command.type === 'shutdown') { void request(0); return }
        else throw Error('Invalid supervisor frame')
      } catch { void request(1); return }
    }
  }
  input?.on('data', data); input?.once('end', eof); input?.once('error', eof)
  if (input) heartbeat()
  return { request }
}
