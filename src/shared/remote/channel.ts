/**
 * 最小双工信道:能发一行文本、能收一行文本、能关、关了能知道。
 *
 * ★★为什么单独一个文件:这个类型是**三层之间唯一的接缝**——
 *  `serveConnection`(服务端跑方法表)、`e2eChannel`(加解密)、以及各种传输
 *  (`ws` 的一条连接、中转上的一条逻辑连接、单测里的一对数组)都只认它。
 *  它原来长在 `src/main/remote/serveConnection.ts` 里,而那个文件 import 了 `node:crypto` ——
 *  手机端要用加密层就得把整条链拖进 RN 的 bundle,而那是拖不动的。
 *  ★所以这里**零 import**,而且永远不该有。
 */
export type Channel = {
  /** 发一帧。★实现方自己吞掉「已经关了」的写失败 —— 一条写不出去不该炸掉整个网关。 */
  send: (text: string) => void
  /** 收到一帧。只会被调用一次来注册。 */
  onMessage: (cb: (text: string) => void) => void
  /** 主动关掉。`code`/`reason` 对 ws 有意义,对别的实现可以忽略。 */
  close: (code: number, reason: string) => void
  /** 关掉了(不论谁关的)。只会被调用一次来注册。 */
  onClose: (cb: () => void) => void
}
