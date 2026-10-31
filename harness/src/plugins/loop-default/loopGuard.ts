// 死循环检测(spec §8.5):同一工具 + 同一参数(JSON 键排序后)连续出现的次数

export const LOOP_REMINDER = '你已重复同一调用 3 次,换个办法或说明卡在哪'
const WARN_AT = 3
const STOP_AT = 5

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().map(k => [k, canonical(o[k])]))
  }
  return v
}

/** 参数规范化:合法 JSON → 键排序后的 JSON;否则原样 */
export function canonicalArgs(raw: string): string {
  try {
    return JSON.stringify(canonical(JSON.parse(raw)))
  } catch {
    return raw
  }
}

export class LoopGuard {
  private last: string | undefined
  private count = 0

  /** 第 3、4 次 → warn(结果后追加提醒);第 5 次 → stop(不执行,结束本轮) */
  see(name: string, rawArgs: string): 'ok' | 'warn' | 'stop' {
    const key = JSON.stringify([name, canonicalArgs(rawArgs)])
    this.count = key === this.last ? this.count + 1 : 1
    this.last = key
    if (this.count >= STOP_AT) return 'stop'
    if (this.count >= WARN_AT) return 'warn'
    return 'ok'
  }
}
