import { NOOP_CTX, type MethodTable } from './invokeCtx'

/**
 * 测试辅助:把方法表摊成 `[channel, fn]` 数组 —— 形状和旧的 `ipcMain.handle.mock.calls` 一样,
 * 且 fn 仍按 `(event, ...args)` 调用。于是既有几十个 `.find(c => c[0] === CH.x)?.[1]` 调用点
 * 一行都不用改,这次重构在测试侧也保持零 churn。
 *
 * 第一个参数(旧的假 event)被丢弃,真正喂给 handler 的是 NOOP_CTX:测试里没有「调用方」可回。
 * 要断言「只回调用方」那条路的用例,自己传一个能记账的 InvokeCtx,别用这个辅助。
 */
export function tableCalls(t: MethodTable): [string, (e: unknown, ...a: any[]) => any][] {
  return Object.entries(t).map(([ch, fn]) => [ch, (_e: unknown, ...a: any[]) => fn(NOOP_CTX, ...a)])
}
