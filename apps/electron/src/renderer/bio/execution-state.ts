import type { ResearchRunView, ResearchConnectionView, ResearchTrace } from '@bio-evidence/research-core'
export function recentModelSuccess(view: ResearchRunView | undefined, connection: ResearchConnectionView | undefined, model: string, now = Date.now()): number | undefined {
  if (!view || !connection?.enabled || view.manifest.connectionId !== connection.slug || view.manifest.model !== model || view.connectionRevision !== connection.revision) return undefined
  const item = view.trace?.filter(event => event.kind === 'model' && event.state === 'completed' && event.finishedAt !== undefined).at(-1)
  return item?.finishedAt !== undefined && now >= item.finishedAt && now - item.finishedAt <= 300000 && view.modelRequests.some(request => request.state === 'completed') ? item.finishedAt : undefined
}
export function traceDuration(event: ResearchTrace): number | undefined {
  return event.finishedAt !== undefined && event.finishedAt >= event.startedAt ? event.finishedAt - event.startedAt : undefined
}
