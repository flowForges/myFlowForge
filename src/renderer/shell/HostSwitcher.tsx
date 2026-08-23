import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { describeHostState, type HostStatusView, type RemoteHostView } from '@shared/remote/hostView'

/**
 * 标题栏正中的主机切换器。
 *
 * 设计上的三条:
 * ① **居中**。主机是「你现在看的是哪台机器」—— 它统辖整个窗口的内容(工作区、会话、运行),
 *    不属于左边的面包屑也不属于右边的工具按钮。放正中,和 macOS 放窗口标题是同一个道理。
 * ② **点开是切换菜单,不是跳设置**。切主机是高频动作,配置主机是低频动作;
 *    把高频动作藏进设置面板里是本末倒置。「主机设置」用分割线隔开放在最下面 ——
 *    它不是一个「切到哪台」的选项,混在一起会让人误点。
 * ③ **一台主机都没配过的人看不到它**。从不用远程的人,界面与以前完全一致。
 */
export function HostSwitcher({ onOpenHosts }: { onOpenHosts: () => void }) {
  const [status, setStatus] = useState<HostStatusView | null>(null)
  const [hosts, setHosts] = useState<RemoteHostView[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [changedBy, setChangedBy] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const reloadHosts = useCallback(() => {
    void (window.forge as typeof window.forge | undefined)?.hostsList?.().then(setHosts).catch(() => { /* 没有就没有 */ })
  }, [])

  useEffect(() => {
    const forge = window.forge as typeof window.forge | undefined
    if (!forge?.onHostStatus) return
    // 先订阅再拉快照,晚到的快照丢掉 —— 否则刚连上就会被一个更旧的快照盖回「未连接」。
    let pushed = false
    const off = forge.onHostStatus((s) => { pushed = true; setStatus(s) })
    void forge.hostsStatus?.().then((s) => { if (!pushed) setStatus(s) }).catch(() => {})
    reloadHosts()
    return off
  }, [reloadHosts])

  useEffect(() => (window.forge as typeof window.forge | undefined)?.onSettingsChangedBy?.((p) => {
    setChangedBy(p.by)
    setTimeout(() => setChangedBy(''), 6000)
  }), [])

  // 菜单挂在 body 上:标题栏在壁纸模式下有 backdrop-filter,会造出层叠上下文把弹层压到面板后面
  // (「打开位置」那个下拉就栽过这个坑)。所以锚到按钮的视口矩形,portal 出去。
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onResize = () => setOpen(false)
    document.addEventListener('click', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize) }
  }, [open])

  // ★一台主机都没配过 → 什么都不渲染。不用远程的人不该因为这个功能多出一个控件。
  if (!status || hosts.length === 0) return null

  const d = describeHostState(status.state)
  const currentId = status.hostId

  const toggle = () => {
    if (!open) {
      const r = ref.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 6, left: r.left + r.width / 2 })
      reloadHosts()
      setErr('')
    }
    setOpen((v) => !v)
  }

  const go = async (id: string | null) => {
    setOpen(false)
    setBusy(true)
    setErr('')
    try {
      if (id === null) await window.forge.hostsDisconnect()
      else await window.forge.hostsConnect(id)
    } catch (e) {
      // 连接失败不能只在控制台里 —— 切换是用户主动发起的动作,失败必须当面说。
      setErr(e instanceof Error ? e.message : String(e))
      setTimeout(() => setErr(''), 8000)
    } finally { setBusy(false) }
  }

  const row = (key: string, label: string, active: boolean, note: string, onClick: () => void) => (
    <button key={key} type="button" className={`hs-item${active ? ' on' : ''}`} role="menuitemradio" aria-checked={active} onClick={onClick}>
      <span className="tick">{active ? '✓' : ''}</span>
      <span className="nm">{label}</span>
      {note && <span className="note">{note}</span>}
    </button>
  )

  return (
    <div className="host-switch" ref={ref}>
      <button
        type="button"
        className={`hs-chip ${d.tone}${busy ? ' busy' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        title={`${status.label} · ${d.text}`}
      >
        <span className="dot" />
        <span className="nm">{status.label}</span>
        {d.short && <span className="st">{d.short}</span>}
        {changedBy && <span className="st">「{changedBy}」改了设置</span>}
        <svg className="cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>

      {err && <div className="hs-err" role="alert">{err}</div>}

      {open && pos && createPortal(
        <div className="hs-pop" style={{ top: pos.top, left: pos.left }} role="menu" onClick={(e) => e.stopPropagation()}>
          {row('local', '本机', currentId === null, currentId === null ? d.short : '', () => void go(null))}
          {hosts.map((h) => row(
            h.id,
            h.label || '(未命名)',
            currentId === h.id,
            currentId === h.id ? d.short || '已连接' : (h.kind === 'ssh' ? 'SSH' : '直连'),
            () => void go(h.id),
          ))}
          {/* ★分割线:下面这条不是「切到哪台」,是「去配置」。混在一起会让人误点。 */}
          <div className="hs-sep" />
          <button type="button" className="hs-item plain" role="menuitem" onClick={() => { setOpen(false); onOpenHosts() }}>
            <span className="tick" /><span className="nm">主机设置…</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}
