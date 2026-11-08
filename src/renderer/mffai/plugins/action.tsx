// 插件页按钮的动作:ref 守卫(同一帧两次点击只发一次)、忙、失败。
// 失败:-32602 带稳定代码 → CodeChip;-32601 → 不支持;别的 → 失败。只记方法和错误码,不记参数(配置值)。
import { useEffect, useRef, useState } from 'react'
import { isUnsupported, toCallError } from '../rpc'
import { SaveFailureChip, type SaveFailure } from '../conn/Projects'

const ERR_INVALID = -32602

export type Failure = SaveFailure

export function failureOf(method: string, e: unknown): Failure {
  const c = toCallError(e)
  console.error(`mffai ${method}`, c.code)
  return isUnsupported(c) ? 'unsupported' : c.code === ERR_INVALID && c.message ? { code: c.message } : 'failed'
}

export const FailChip = ({ failure }: { failure: Failure | null }) => <SaveFailureChip failure={failure} />

export function useAction() {
  const inflight = useRef(false)
  const alive = useRef(true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  /** 进行中再点:不发,回 false */
  const run = async (method: string, f: () => Promise<unknown>): Promise<boolean> => {
    if (inflight.current) return false
    inflight.current = true
    setBusy(true)
    setFailure(null)
    try {
      await f()
      return true
    } catch (e) {
      const fl = failureOf(method, e)
      if (alive.current) setFailure(fl)
      return false
    } finally {
      inflight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return { run, busy, failure, setFailure, alive }
}
