import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigDir } from '@craft-agent/shared/config/namespace.mjs'
import { startBioServer } from '../bio-index'
import { createOwnedShutdown, finishOwnedShutdown } from '../owned-shutdown'
const instance = await startBioServer()
// Fixture-only cleanup, beyond startup + acceptance deadlines; no bare PID kills.
setTimeout(() => process.exit(2), 30000).unref()
console.log(`BioEvidence account service: ${instance.boundary.publicOrigin}`)
createOwnedShutdown(instance.stop, code => {
  writeFileSync(join(resolveConfigDir(), 'shutdown-proof.json'), JSON.stringify({ complete: true, code, pid: process.pid }), { flag: 'wx' })
  finishOwnedShutdown(code)
}, process.stdin)
