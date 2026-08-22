export type Sink = (channel: string, payload: unknown) => void

/**
 * 事件外推的分发点 —— 所有广播出去的东西都从这里出去。
 *
 * `registerIpc(broadcast, …)` 一开始就把外推做成了注入的普通函数,业务逻辑从来不知道
 * Electron 存在。缺的只是「同时推给多个去处」:本机窗口一路,第二期起每个连上来的
 * 远程客户端各一路。
 *
 * 三条不变式,每条都对应一种**静默**的失效:
 * ① 退订按**令牌**而不是按函数身份 —— 重连时同一个 sink 函数会被重新挂上,按身份删
 *    会连新的一起删掉,表现为「那个客户端从此收不到任何事件」,且不报错。
 * ② 单个 sink 抛错就地吞掉 —— 远程 socket 可能在写入瞬间断开,不能让它连累排在后面的
 *    本机窗口。
 * ③ 遍历前先拍快照 —— sink 在收到广播时把自己摘掉(「写失败就退订」是远程 sink 的自然
 *    写法)是边遍历边改集合,会漏发给后面的人。
 */
export function createBroadcastHub() {
  let seq = 0
  const sinks = new Map<number, Sink>()
  return {
    broadcast(channel: string, payload: unknown): void {
      for (const sink of [...sinks.values()]) {
        try { sink(channel, payload) } catch { /* 掉线的 sink 不能连坐其它人 */ }
      }
    },
    addSink(sink: Sink): () => void {
      const token = ++seq
      sinks.set(token, sink)
      return () => { sinks.delete(token) }
    },
    sinkCount: () => sinks.size,
  }
}
