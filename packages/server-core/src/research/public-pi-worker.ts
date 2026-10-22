import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { PublicPiStartSchema, PublicPiReplySchema, PublicPiErrorCodeSchema } from './public-pi-protocol'
import { ResearchError, parseContract } from '@bio-evidence/research-core'
// stdout is exclusively the bounded parent protocol. SDK diagnostics never expose inputs or keys.
console.log = console.warn = console.error = console.debug = console.info = () => {}
const pending = new Map<string, { resolve: () => void; reject: () => void }>()
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
const fail = (error: unknown) => {
  const parsed = PublicPiErrorCodeSchema.safeParse(error instanceof ResearchError ? error.code : undefined)
  send({ type: 'error', code: parsed.success ? parsed.data : 'BIO_MODEL_UNAVAILABLE' }); process.exit(1)
}
let started = false
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!started) {
      const start = parseContract(PublicPiStartSchema, JSON.parse(line)); started = true
      void (async () => {
        const { runPublicPi } = await import('./public-pi-runtime')
        const check = (frame: object) => new Promise<void>((resolve, reject) => {
          if (pending.size > 1) { reject(new ResearchError('BIO_MODEL_UNAVAILABLE')); return }
          const id = randomUUID(); pending.set(id, { resolve, reject: () => reject(new ResearchError('BIO_ACCESS_DENIED')) }); send({ type: 'check', id, ...frame })
        })
        const text = await runPublicPi(start.job, { inspect: start.mode === 'inspect', authorize: kind => check({ kind }), attempt: event => check({ kind: 'attempt', attempt: event }), toolEvent: event => check({ kind: 'tool-event', event }) })
        send({ type: 'result', text }); process.exit(0)
      })().catch(fail)
    } else {
      const reply = parseContract(PublicPiReplySchema, JSON.parse(line)), waiter = pending.get(reply.id)
      if (!waiter) throw new ResearchError('BIO_MODEL_UNAVAILABLE')
      pending.delete(reply.id); reply.type === 'allow' ? waiter.resolve() : waiter.reject()
    }
  }
} catch (error) { fail(error) }
