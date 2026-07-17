export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

export class ResolverRegistry<T> {
  private map = new Map<string, (v: T) => void>()
  create(id: string): Promise<T> {
    const d = deferred<T>()
    this.map.set(id, d.resolve)
    return d.promise
  }
  settle(id: string, value: T): boolean {
    const r = this.map.get(id)
    if (!r) return false
    this.map.delete(id)
    r(value)
    return true
  }
  has(id: string): boolean { return this.map.has(id) }
  pendingIds(): string[] { return [...this.map.keys()] }
  settleAll(value: T): void {
    for (const [, r] of this.map) r(value)
    this.map.clear()
  }
}
