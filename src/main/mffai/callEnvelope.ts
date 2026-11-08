// mffai:call 的信封(08 §5.2)。★不 import 任何东西:preload 也用它。

export type CallError = { code: number; message: string; data?: unknown }
export type CallEnvelope = { ok: true; result: unknown } | { ok: false; error: CallError }

/**
 * preload 抛给页面的错误。★是普通对象而不是 Error:contextBridge 复制 Error 时丢掉自定义属性
 * (code、data 就没了),普通对象的字段原样复制。渲染层的 MffaiCallError 再把它包成 Error 子类
 */
export type MffaiCallErrorShape = { name: 'MffaiCallError'; code: number; message: string; data?: unknown }

const callError = (e: CallError): MffaiCallErrorShape =>
  ({ name: 'MffaiCallError', code: e.code, message: e.message, ...(e.data !== undefined && { data: e.data }) })

/** 成功 → result;失败 → 抛 MffaiCallErrorShape;信封不像样 → -32603 */
export function unwrapCall(env: CallEnvelope): unknown {
  if (env && typeof env === 'object' && env.ok === true) return env.result
  const e = env && typeof env === 'object' && env.ok === false ? env.error : undefined
  if (e && typeof e === 'object' && typeof e.code === 'number') {
    throw callError({ code: e.code, message: typeof e.message === 'string' ? e.message : '', data: e.data })
  }
  throw callError({ code: -32603, message: 'malformed envelope' })
}
