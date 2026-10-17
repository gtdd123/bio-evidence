import type { PublicAccount, ResearchRequestChannel, ResearchRpcChannelMap, ResearchEvent, DocumentIngestResult, ArtifactExport } from '@bio-evidence/research-core'
export type ResearchClientApi = {
  [C in ResearchRequestChannel as C extends `research:v1:${infer M}` ? M : never]: (...args: ResearchRpcChannelMap[C]['args']) => Promise<ResearchRpcChannelMap[C]['result']>
} & { onEvent(callback: (event: ResearchEvent) => void): () => void }
export interface BioClientState { origin: string; account: PublicAccount | null; status: 'signed-out' | 'connecting' | 'connected' | 'disconnected' | 'error'; errorCode?: string; epoch: number; viewRevision?: number }
export interface BioPdfImport { sessionId: string; expectedRevision: number; declaredPublic: boolean }
/** The only surface shared by the Bio renderer on Web and Electron. */
export interface BioHostApi {
  research: ResearchClientApi
  platform: 'web' | 'desktop'
  account: { current(): Promise<BioClientState>; login(origin: string, username: string, password: string): Promise<BioClientState>; logout(): Promise<void> }
  onState(callback: (state: BioClientState) => void): () => void
  importPdf(input: BioPdfImport): Promise<DocumentIngestResult>
  saveExport(value: ArtifactExport): Promise<{ saved: boolean }>
}
/** Plain DTOs survive Electron contextBridge; custom properties on Error do not. */
export type BioWireResult<T> = { ok: true; result: T } | { ok: false; errorCode: string }
type WireMethod<F> = F extends (...args: infer A) => Promise<infer R> ? (...args: A) => Promise<BioWireResult<R>> : F
export interface BioDesktopWireHost {
  platform: 'desktop'
  research: { [K in keyof ResearchClientApi]: WireMethod<ResearchClientApi[K]> }
  account: { [K in keyof BioHostApi['account']]: WireMethod<BioHostApi['account'][K]> }
  onState: BioHostApi['onState']
  importPdf: WireMethod<BioHostApi['importPdf']>
  saveExport: WireMethod<BioHostApi['saveExport']>
}
