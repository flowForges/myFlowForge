/**
 * 「这一趟拉完了没有」——把下拉刷新那颗转圈和后台那趟快照请求接起来的那道闸。
 *
 * ★为什么需要它:`store.refresh()` 本身只是 `setTick`(同步的),它没法回答「拉完了没有」。
 *  没有答案的话,转圈只能拍个定时器瞎猜 —— 猜短了人以为没刷新,猜长了人以为卡住,
 *  两种都比不刷新更糟(这一屏的全部意义就是「电脑上刚建的东西,手机上看得见」)。
 *
 * ★零 import 的纯逻辑,所以能在 node 那套 vitest 里直接测(`store.tsx` 是 .tsx,进不了)。
 *  真正的用法在 `store.tsx`:请求发出前 `wait()`,快照 effect 的**成功和失败两条路**都 `settle()`,
 *  外加没连主机时立刻 `settle()` —— 少任何一处,下拉都会永久转圈。
 */
export type RefreshGate = {
  /** 排一个队,等下一次 `settle()`。 */
  wait: () => Promise<void>
  /** 兑现当前排着的**全部**等待者。没人等着时什么也不做。 */
  settle: () => void
  /** 现在有几个人等着。给测试和调试看的。 */
  pending: () => number
}

export function createRefreshGate(): RefreshGate {
  let waiting: (() => void)[] = []
  return {
    wait: () => new Promise<void>((res) => { waiting.push(res) }),
    settle: () => {
      // 先清空、再逐个调。★这一条是**防御性**的,不是在修一个现有的 bug:等待者是 promise 的
      //  resolve,它触发的 `.then` 是微任务,跑在这个同步循环**之后** —— 所以今天没有任何路径
      //  能在循环中途重新入队。变异测试证实了这一点(把顺序反过来,测试全绿)。
      //  留着这个顺序是因为它零成本,而且把「循环中途队列会不会变」这个问题彻底拿掉。
      const list = waiting
      waiting = []
      for (const done of list) done()
    },
    pending: () => waiting.length,
  }
}
