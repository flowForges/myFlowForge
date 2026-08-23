/**
 * 一次调用的「回调用方」通道。
 *
 * 广播(broadcast)是发给所有人的;这个是只发给**发起本次调用的那个客户端**。
 * 两个 handler 语义上必须要它:`fontsDownload` 的下载进度、`nsfwGallery` 的预览图,
 * 都只该回给按了按钮的那个窗口 —— 广播出去等于让别人的界面跟着动,
 * 第二期之后更等于让所有连上来的手机都收到别人的下载进度。
 *
 * Electron 宿主用 `e.sender.send` 实现;第二期 B 的 WS 宿主用「回这条 socket」实现。
 */
export type InvokeCtx = {
  emit(channel: string, payload: unknown): void
  /**
   * 这一刀是谁发的。本机窗口是 `{ id: 'local', label: '本机' }`,远程客户端是它自报的名字。
   *
   * ★为什么需要:权限门在多客户端下会骗人 —— 手机点了「允许」,电脑上的卡片消失前有几百毫秒,
   * 电脑前的人完全可能在这期间点了「拒绝」。第二个答案被静默丢弃,**他会以为自己拦住了那条
   * `rm -rf`,其实已经放行了**。要说清「是谁答的」,就得知道调用方是谁。
   */
  client?: { id: string; label: string }
}

/**
 * 兼容层:既有 handler 的第一个参数是 Electron 的 IpcMainInvokeEvent,写法是 `(_e, arg) => …`。
 * 给它们喂一个只长得像、但不含任何 Electron 依赖的东西,就能把 159 处签名改动压成 0 ——
 * 这次重构的目标是**零行为变化**,签名 churn 是纯风险。
 */
export type InvokeEventLike = {
  sender: { send(channel: string, payload: unknown): void }
  /** 透传 InvokeCtx.client —— 权限门要靠它说清「是谁答的」。 */
  client?: InvokeCtx['client']
}

/** 方法表:channel 字符串 → 处理函数。宿主(Electron / 第二期 B 的 WS 网关)遍历它完成注册。 */
export type MethodTable = Record<string, (ctx: InvokeCtx, ...args: unknown[]) => unknown>

/** 没有调用方可回的场合(测试、内部调用)用它,emit 直接丢弃。 */
export const NOOP_CTX: InvokeCtx = { emit: () => {}, client: { id: 'local', label: '本机' } }
