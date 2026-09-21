import { useEffect, useRef, useState } from 'react'
import { relayUrlChoices, isRelayUrl, canForgetRelayUrl, normalizeRelayUrl } from '@shared/remote/relayHistory'

/**
 * 中转地址的下拉:点开看全部保存过的地址,点一条切换,× 删一条,最底下「+ 新增地址」。
 *
 * ★★用户原话(2026-09-21):「用户输入的,应该可以保存,然后下次可以下拉选择,也支持删除之前填写的,
 *  比如我有多个中转域名,就支持点击切换,还支持新增」。
 *
 * ★为什么不再用 `<input list>` + `<datalist>`(09-17 那一版):原生 datalist 会**按输入框里已有的字过滤**。
 *  框里填着当前地址时,下拉只剩它自己(甚至什么都没有),其它保存过的一个都看不到 —— 也就谈不上「点击切换」。
 *  而且它没法放删除按钮。这里自绘,外观沿用设置里的 `Select`(`.set-sel*`):同一个 app 里点开一张单子
 *  挑一项,只该有一种长相。
 *
 * ★「新增」和「切换」是**两个动作**:新增只是把地址存进单子,不换过去。切换会让走中转连进来的设备
 *  断开(它们记着旧地址,要重新扫码),所以切换前必须问一句 —— 不能让人为了先存一个备用地址,
 *  结果把正连着的手机全断了。唯一的例外:一个地址都还没用过时,新增的那条直接用上(没有可断的)。
 */
export function RelayUrlPicker({
  current,
  history,
  disabled,
  onSwitch,
  onRemember,
  onForget,
}: {
  current: string
  history: readonly string[]
  disabled?: boolean
  onSwitch: (url: string) => Promise<unknown>
  onRemember: (url: string) => Promise<unknown>
  onForget: (url: string) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const cur = normalizeRelayUrl(current)
  const choices = relayUrlChoices(current, history)

  // 点外面关掉(同 Select:挂 document,不盖遮罩 —— 遮罩会吃掉「点另一个控件」那一下)。
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) close() }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const close = () => { setOpen(false); setAdding(false); setDraft(''); setErr('') }
  // 主进程那边也会拒绝(比如删正在用的那条),把它的话原样显示出来,而不是静默没反应。
  const run = async (p: Promise<unknown>) => {
    try { await p; setErr('') } catch (e) { setErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)) }
  }

  const switchTo = async (url: string) => {
    if (normalizeRelayUrl(url) === cur) { close(); return }
    if (cur && !window.confirm(
      `切换中转地址到\n${url}\n\n已经通过中转连进来的手机 / 电脑记着的是旧地址,切换后要重新扫码才能连上。` +
      '\n(局域网直连不受影响。)',
    )) return
    close()
    await run(onSwitch(url))
  }

  const submit = async () => {
    const v = normalizeRelayUrl(draft)
    if (!isRelayUrl(v)) { setErr('地址要以 ws:// 或 wss:// 开头,例如 wss://relay.你的域名'); return }
    if (choices.includes(v)) { setErr('这个地址已经在单子里了'); return }
    if (!cur) { close(); await run(onSwitch(v)); return }   // 还没用过任何中转:加上就用
    setAdding(false); setDraft('')
    await run(onRemember(v))
  }

  return (
    <div
      className="set-sel rup"
      ref={rootRef}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close() } }}
    >
      <button
        type="button"
        className={`set-sel-btn${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="中转地址"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className={`set-sel-val${cur ? '' : ' rup-placeholder'}`}>{cur || '还没有中转地址 —— 点开新增'}</span>
        <svg className="set-sel-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="set-sel-pop">
          <div role="listbox" aria-label="保存过的中转地址">
            {choices.map((u) => {
              const on = u === cur
              const deletable = canForgetRelayUrl(u, current)
              return (
                <div className="rup-row" key={u}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`set-sel-item${on ? ' on' : ''}`}
                    title={on ? '正在使用' : `切换到 ${u}`}
                    onClick={() => void switchTo(u)}
                  >
                    <span className="rup-url">{u}</span>
                    <svg className="set-sel-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="rup-del"
                    aria-label={`删除 ${u}`}
                    disabled={!deletable}
                    title={deletable ? '从单子里删掉' : '正在使用 —— 先切到别的地址才能删'}
                    onClick={() => void run(onForget(u))}
                  >×</button>
                </div>
              )
            })}
            {choices.length === 0 && <div className="rup-empty">还没有保存过中转地址</div>}
          </div>

          <div className="rup-sep" />
          {adding ? (
            <div className="rup-add">
              <input
                autoFocus
                aria-label="新的中转地址"
                placeholder="wss://relay.你的域名"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setErr('') }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }}
              />
              <button type="button" className="set-btn" onClick={() => void submit()}>添加</button>
            </div>
          ) : (
            <button type="button" className="set-sel-item rup-new" onClick={() => { setAdding(true); setErr('') }}>
              + 新增地址
            </button>
          )}
          {err && <div className="rup-err" role="alert">{err}</div>}
        </div>
      )}
    </div>
  )
}
