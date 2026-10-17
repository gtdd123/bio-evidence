/** Text only, private to this window, bounded and partitioned by the authenticated identity. */
export function bioDraftOwner(origin: string, accountId: string) { return JSON.stringify([origin, accountId]) }
export class BioDraftVault {
  private entries = new Map<string, string>()
  private bytes = 0
  constructor(private readonly maxBytes = 4 * 1024 * 1024, private readonly maxEntries = 100) {}
  private key(ownerId: string, resource: readonly string[]) { return JSON.stringify([ownerId, ...resource]) }
  get(ownerId: string, resource: readonly string[]): string | undefined { return this.entries.get(this.key(ownerId, resource)) }
  set(ownerId: string, resource: readonly string[], text: string): void {
    const key = this.key(ownerId, resource), size = new TextEncoder().encode(key + text).length
    const old = this.entries.get(key), previousSize = old === undefined ? 0 : new TextEncoder().encode(key + old).length
    const nextBytes = this.bytes - previousSize + size
    if (size > this.maxBytes || nextBytes > this.maxBytes || old === undefined && this.entries.size >= this.maxEntries) throw Error('BIO_DRAFT_BUDGET')
    // Never evict an unresolved submission or conflict draft to make room for navigation.
    this.entries.set(key, text); this.bytes = nextBytes
  }
  remove(ownerId: string, resource: readonly string[]): void {
    const key = this.key(ownerId, resource), old = this.entries.get(key)
    if (old === undefined) return
    this.entries.delete(key); this.bytes -= new TextEncoder().encode(key + old).length
  }
}
