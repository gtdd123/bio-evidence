import { ResearchError } from '@bio-evidence/research-core'
type Closeable = { close(): unknown | Promise<unknown> }
export interface BioResources {
  repository: Closeable; server?: Closeable; runs?: Closeable; modelWorker?: Closeable
  documentHttp?: Closeable; snapshots?: Closeable; previews?: Closeable; stopMaintenance?: () => void
}
/** Keep dependency order, but one failure must never skip the remaining cleanup. */
export async function closeBioResources(resources: BioResources): Promise<void> {
  let failed = false
  const steps = [resources.stopMaintenance, ...[resources.server, resources.runs, resources.modelWorker, resources.documentHttp, resources.snapshots, resources.previews, resources.repository]
    .map(resource => resource ? () => resource.close() : undefined)]
  for (const close of steps) { try { await close?.() } catch { failed = true } }
  if (failed) throw new ResearchError('BIO_STORAGE_UNAVAILABLE')
}
