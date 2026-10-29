// 服务注册表:按 key 提供/获取服务,支持等待依赖就绪
export class ServiceRegistry {
  private services = new Map<string, unknown>()
  private waiters: Array<() => void> = []

  provide<T>(key: string, impl: T): () => void {
    if (this.services.has(key)) throw new Error(`service ${key} already provided`)
    this.services.set(key, impl)
    for (const w of [...this.waiters]) w()
    return () => {
      // 只撤销自己提供的那一份
      if (this.services.get(key) === impl) this.services.delete(key)
    }
  }

  get<T>(key: string): T | undefined {
    return this.services.get(key) as T | undefined
  }

  // 空数组立即 resolve;自身不带超时
  whenReady(keys: string[]): Promise<void> {
    const ready = () => keys.every(k => this.services.has(k))
    if (ready()) return Promise.resolve()
    return new Promise(resolve => {
      const check = () => {
        if (!ready()) return
        this.waiters = this.waiters.filter(w => w !== check)
        resolve()
      }
      this.waiters.push(check)
    })
  }
}
