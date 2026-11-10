// Telegram 配对(08 §10.3)。码只在这个组件的 state 里:过期、取消、卸载、channel.paired、channel.pairing.burned
// 时清掉。卸载时这个组件发出的码还在,就顺手 pairing.cancel(没人看得见的码不该还能用);别处开的配对不动。
// 不进铃铛、不进日志、不进存储;出错只记方法和错误码。链接只认主进程放行的那一种形状
// (host.ts TELEGRAM_START),二维码的内容就是链接,它的名字不带码。
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../shell/icons'
import { QrCode } from '../../settings/QrCode'
import { call, isUnsupported, toCallError } from '../rpc'
import { useMffaiEvent } from '../events'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Countdown } from '../ui/Countdown'

const ERR_INVALID = -32602
/** 和 src/main/mffai/host.ts 的 TELEGRAM_START 一致 */
const TELEGRAM_START = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=[A-Za-z0-9_-]+$/

type Active = { code: string; expiresAt: number; from: number; link?: string }
type Failure = { code?: string; unsupported?: boolean }

export function Pairing({ active, onChanged }: { active: boolean; onChanged?: () => void }) {
  const [pair, setPairState] = useState<Active | null>(null)
  /** 卸载时看的:这个组件发出的码是不是还在 */
  const held = useRef(false)
  const setPair = (p: Active | null) => { held.current = p !== null; setPairState(p) }
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<Failure | null>(null)
  const inflight = useRef(false)
  const alive = useRef(true)
  const changed = useRef(onChanged)
  changed.current = onChanged
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (!held.current) return
      held.current = false
      void call('channel.telegram.pairing.cancel', {}).catch((e: unknown) => console.error('mffai channel.telegram.pairing.cancel', toCallError(e).code))
    }
  }, [])

  useMffaiEvent({ types: ['channel.paired', 'channel.pairing.burned'] }, () => setPair(null))

  const fail = (method: string, e: unknown) => {
    const c = toCallError(e)
    // 只记方法和码:消息里没有码,但不冒这个险
    console.error(`mffai ${method}`, c.code)
    if (alive.current) setFailed(isUnsupported(c) ? { unsupported: true } : c.code === ERR_INVALID && c.message ? { code: c.message } : {})
  }

  const begin = async () => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setFailed(null)
    try {
      const r = await call('channel.telegram.pairing.begin', {})
      if (!alive.current) {
        // 码到的时候组件已经没了:没人看得见,收回
        void call('channel.telegram.pairing.cancel', {}).catch((e: unknown) => console.error('mffai channel.telegram.pairing.cancel', toCallError(e).code))
        return
      }
      setPair({ code: r.code, expiresAt: r.expiresAt, from: Date.now(), ...(r.link && TELEGRAM_START.test(r.link) && { link: r.link }) })
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

  const copy = (link: string) => void Promise.resolve(navigator.clipboard?.writeText(link)).catch(() => console.error('mffai clipboard'))

  return (
    <div className={`mffai-pairing mffai-tgcard${pair ? ' live' : ''}`}>
      {pair ? (
        <div className="mffai-pair-live">
          {pair.link && <QrCode text={pair.link} alt="配对二维码" />}
          <div className="mffai-pair-main">
            <Chip tone="acc" dot>配对中</Chip>
            <span className="mffai-paircode">{pair.code}</span>
            <Countdown from={pair.from} until={pair.expiresAt} onDone={() => { setPair(null); changed.current?.() }} />
            <div className="mffai-pair-acts">
              {pair.link && <button className="set-btn mffai-primary" aria-label="打开链接" onClick={() => open(pair.link!)}><Icon name="ext" size={13} />在 Telegram 打开</button>}
              {pair.link && <button className="set-btn" onClick={() => copy(pair.link!)}><Icon name="copy" size={13} />复制链接</button>}
              <button className="set-btn" onClick={() => void cancel()}>取消</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mffai-row">
          <button className="set-btn mffai-primary" disabled={busy} onClick={() => void begin()}>开始配对</button>
          {active && <Chip tone="warn">配对中</Chip>}
          {active && <button className="set-btn" disabled={busy} onClick={() => void cancel()}>取消</button>}
        </div>
      )}
      {failed && (failed.unsupported ? <Chip tone="bad">不支持</Chip> : failed.code ? <CodeChip code={failed.code} /> : <span className="mffai-fail">失败</span>)}
    </div>
  )
}
