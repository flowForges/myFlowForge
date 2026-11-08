// Telegram 配对(08 §10.3)。码只在这个组件的 state 里:过期、取消、卸载、channel.paired、channel.pairing.burned
// 时清掉。不进铃铛、不进日志、不进存储;出错只记方法和错误码。链接只认主进程放行的那一种形状
// (host.ts TELEGRAM_START),二维码的内容就是链接,它的名字不带码。
import { useEffect, useRef, useState } from 'react'
import { QrCode } from '../../settings/QrCode'
import { call, toCallError } from '../rpc'
import { useMffaiEvent } from '../events'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Countdown } from '../ui/Countdown'

const ERR_INVALID = -32602
/** 和 src/main/mffai/host.ts 的 TELEGRAM_START 一致 */
const TELEGRAM_START = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=[A-Za-z0-9_-]+$/

type Active = { code: string; expiresAt: number; link?: string }
type Failure = { code?: string }

export function Pairing({ active, onChanged }: { active: boolean; onChanged?: () => void }) {
  const [pair, setPair] = useState<Active | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<Failure | null>(null)
  const inflight = useRef(false)
  const alive = useRef(true)
  const changed = useRef(onChanged)
  changed.current = onChanged
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useMffaiEvent({ types: ['channel.paired', 'channel.pairing.burned'] }, () => setPair(null))

  const fail = (method: string, e: unknown) => {
    const c = toCallError(e)
    // 只记方法和码:消息里没有码,但不冒这个险
    console.error(`mffai ${method}`, c.code)
    if (alive.current) setFailed(c.code === ERR_INVALID && c.message ? { code: c.message } : {})
  }

  const begin = async () => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setFailed(null)
    try {
      const r = await call('channel.telegram.pairing.begin', {})
      if (!alive.current) return
      setPair({ code: r.code, expiresAt: r.expiresAt, ...(r.link && TELEGRAM_START.test(r.link) && { link: r.link }) })
      changed.current?.()
    } catch (e) {
      fail('channel.telegram.pairing.begin', e)
    } finally {
      inflight.current = false
      if (alive.current) setBusy(false)
    }
  }

  const cancel = async () => {
    setPair(null)
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setFailed(null)
    try {
      await call('channel.telegram.pairing.cancel', {})
      changed.current?.()
    } catch (e) {
      fail('channel.telegram.pairing.cancel', e)
    } finally {
      inflight.current = false
      if (alive.current) setBusy(false)
    }
  }

  const open = (link: string) => void window.forge.mffai.openExternal(link).catch((e: unknown) => console.error('mffai openExternal', toCallError(e).code))

  return (
    <div className="mffai-pairing">
      {pair ? (
        <>
          <div className="mffai-row">
            <span className="mffai-paircode">{pair.code}</span>
            <Countdown until={pair.expiresAt} onDone={() => setPair(null)} />
            {pair.link && <button className="set-btn" onClick={() => open(pair.link!)}>打开链接</button>}
            <button className="set-btn" onClick={() => void cancel()}>取消</button>
          </div>
          {pair.link && <QrCode text={pair.link} alt="配对二维码" />}
        </>
      ) : (
        <div className="mffai-row">
          <button className="set-btn" disabled={busy} onClick={() => void begin()}>开始配对</button>
          {active && <Chip tone="warn">配对中</Chip>}
          {active && <button className="set-btn" disabled={busy} onClick={() => void cancel()}>取消</button>}
        </div>
      )}
      {failed && (failed.code ? <CodeChip code={failed.code} /> : <span className="mffai-fail">失败</span>)}
    </div>
  )
}
