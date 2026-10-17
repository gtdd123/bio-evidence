import { ResearchError } from '@bio-evidence/research-core'
interface OwnerWindow { isDestroyed(): boolean; webContents: { id: number; isDestroyed(): boolean; getURL(): string; mainFrame: unknown } }
interface SenderEvent { sender: OwnerWindow['webContents']; senderFrame: unknown }
export function assertBioWindowSender(owner: OwnerWindow | undefined, event: SenderEvent, rendererUrl: string): void {
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed() || event.sender !== owner.webContents ||
    !event.senderFrame || event.senderFrame !== owner.webContents.mainFrame || owner.webContents.getURL() !== rendererUrl) throw new ResearchError('BIO_ACCESS_DENIED')
}
