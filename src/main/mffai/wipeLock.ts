// 删除全部数据和启用互斥(评审修订 R7)。ipc.ts、设置同步和 host 共用同一把,
// 所以设置开关那条路(config:setClientSettings → onSettings → createMffaiSettingsSync → host.enable)也挡得住。
// ★不 import electron;模块级单例只在 index.ts 的真实接线里用,测试各传各的。

export interface WipeLock {
  /** 删除进行中 */
  active(): boolean
  /** 占住;已经占着 → false */
  begin(): boolean
  end(): void
  /** 没在删 → 立刻;在删 → 删完再 resolve */
  idle(): Promise<void>
  /** host 加载后登记"自己有没有串行操作在跑" */
  setOpProbe(probe: () => string | undefined): void
  /** 已加载的 host 正在做的串行操作;host 没加载 → undefined */
  hostOp(): string | undefined
}

export function createWipeLock(): WipeLock {
  let held = false
  let waiters: Array<() => void> = []
  let probe: (() => string | undefined) | undefined
  return {
    active: () => held,
    begin() {
      if (held) return false
      held = true
      return true
    },
    end() {
      held = false
      const w = waiters
      waiters = []
      for (const r of w) r()
    },
    idle: () => (held ? new Promise<void>((r) => { waiters.push(r) }) : Promise.resolve()),
    setOpProbe(p) { probe = p },
    hostOp: () => probe?.(),
  }
}

export const wipeLock = createWipeLock()
