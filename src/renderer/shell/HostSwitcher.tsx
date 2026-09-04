import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { describeHostState, DEFAULT_HOST_ICON, LOCAL_ICON, type HostDisplay, type HostStatusView, type RemoteHostView } from '@shared/remote/hostView'

/**
 * 底部状态栏最左边那枚主机按钮(在「终端」左边)。
 *
 * ★★2026-09-04 从标题栏正中搬到了这里。用户原话:「我不太喜欢顶部的这个主机按钮,这个位置我感觉
 *  有点难受」。搬家不是换个位置那么简单 —— 标题栏正中**在两个平台上根本不是同一块地方**:
 *  mac 的红绿灯在左上、Windows 的系统键在右上,而 Windows 上整条工具栏还得重排(见 Titlebar)。
 *  于是那枚芯片得靠 `position:fixed + 50vw` 硬挤在正中,还逼着面包屑写死 `max-width: calc(50vw - 260px)`
 *  给它让路。**底部状态栏两个平台完全一样,没有任何系统按钮**,这个位置一劳永逸。
 *
 * 搬过来之后长相就该跟邻居一致,而不是把标题栏那枚原样搬下来:
 * ① 复用「实时日志」那套 `.sb-log`(同样的高度/圆角/等宽字/字号),外加同一枚 `.lg-dot` 圆点。
 * ② **圆点就是连接状态**:绿=连上了、黄=连接中、红=连不上/断了、灰=没连。★本机永远是绿的 ——
 *    「本机」这台从定义上就在线,拿个灰点说它没连是错的(用户特意点了这条:「否则主机一直是亮的」)。
 * ③ 一台远程主机都没配过时:**只画一枚图标,不写字**。原来是整个组件不渲染,可那样这个功能就
 *    彻底没有入口了;缩成一枚图标既不占地方,点开又能走到「主机设置…」。
 *
 * ★显示成什么样(图标/名称/两者)是**这枚按钮的全局设置**,存在 `appearance.hostChip` 里。
 *  旧版存在每台主机上,于是同一枚按钮切一台主机就换一副长相,而且本机没地方存、只能写死。
 */
export function HostSwitcher({ display = 'both', onOpenHosts }: { display?: HostDisplay; onOpenHosts: () => void }) {
  const [status, setStatus] = useState<HostStatusView | null>(null)
  const [hosts, setHosts] = useState<RemoteHostView[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [changedBy, setChangedBy] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null)

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

  // 菜单挂在 body 上:状态栏在壁纸模式下有 backdrop-filter,会造出层叠上下文把弹层压到面板后面
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

  if (!status) return null

  const d = describeHostState(status.state)
  const currentId = status.hostId
  // ★本机固定算「已连接」。`describeHostState` 给 local 的 tone 是 idle(那是给设置面板那张卡片用的),
  //  但在这枚按钮上灰点=没连上,而本机从定义上就是连着的。
  const tone = currentId === null ? 'ok' : d.tone
  const icon = currentId === null ? LOCAL_ICON : (status.icon?.trim() || DEFAULT_HOST_ICON)
  // ★一台远程主机都没配过 → 无视设置,只画图标不写字。「本机」这两个字对从不用远程的人是废话,
  //  而那枚图标是这个功能唯一的入口,不能一起省掉。
  const bare = hosts.length === 0
  const showIcon = bare || display !== 'name'
  const showName = !bare && display !== 'icon'

  const toggle = () => {
    if (!open) {
      const r = ref.current?.getBoundingClientRect()
      // ★往**上**弹 —— 按钮贴着窗口底边,往下弹就弹到屏幕外面去了。锚 bottom 而不是 top:
      //  菜单条数不定(主机可多可少),锚 top 的话高度一变就得反过来重算位置。
      if (r) setPos({ bottom: Math.max(0, window.innerHeight - r.top + 6), left: r.left + r.width / 2 })
      reloadHosts()
      setErr('')
    }
    setOpen((v) => !v)
  }

  const go = async (id: string | null) => {
    setOpen(false)
    // ★点的就是当前这台 → 什么都不做。重连一次既没意义,还会让界面白闪一轮
    //   (断开 → 连接中 → 已连接),看起来像是点坏了。
    if (id === currentId) return
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

  const row = (key: string, label: string, glyph: string, active: boolean, note: string, onClick: () => void) => (
    <button key={key} type="button" className={`hs-item${active ? ' on' : ''}`} role="menuitemradio" aria-checked={active} onClick={onClick}>
      <span className="tick">{active ? '✓' : ''}</span>
      <span className="ico" aria-hidden="true">{glyph}</span>
      <span className="nm">{label}</span>
      {note && <span className="note">{note}</span>}
    </button>
  )

  return (
    <div className="host-switch" ref={ref}>
      <button
        type="button"
        className={`sb-log sb-host ${tone}${busy ? ' busy' : ''}${open ? ' on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        aria-label={`${status.label} · ${d.text}`}
        title={`${status.label} · ${d.text}`}
      >
        {/* 圆点抄「实时日志」那一枚,颜色由 .sb-host.ok/.warn/.bad/.idle 给。 */}
        <span className="lg-dot" />
        {showIcon && <span className="ico" aria-hidden="true">{icon}</span>}
        {showName && <span className="nm">{status.label}</span>}
        {/* ★断线态必须**写出来**,不能只靠一个红点(设计文档十·UI 约束)。ready 时 short 为空,不占位。 */}
        {showName && d.short && <span className="st">{d.short}</span>}
        {showName && changedBy && <span className="st">「{changedBy}」改了设置</span>}
        {showName && <svg className="cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="6 9 12 15 18 9" /></svg>}
      </button>

      {err && <div className="hs-err" role="alert">{err}</div>}

      {open && pos && createPortal(
        <div className="hs-pop up" style={{ bottom: pos.bottom, left: pos.left }} role="menu" onClick={(e) => e.stopPropagation()}>
          {row('local', '本机', LOCAL_ICON, currentId === null, currentId === null ? d.short : '', () => void go(null))}
          {hosts.map((h) => row(
            h.id,
            h.label || '(未命名)',
            h.icon?.trim() || DEFAULT_HOST_ICON,
            currentId === h.id,
            currentId === h.id ? d.short || '已连接' : (h.kind === 'ssh' ? 'SSH' : h.relay ? '中转' : '直连'),
            () => void go(h.id),
          ))}
          {/* ★分割线:下面这条不是「切到哪台」,是「去配置」。混在一起会让人误点。 */}
          <div className="hs-sep" />
          <button type="button" className="hs-item plain" role="menuitem" onClick={() => { setOpen(false); onOpenHosts() }}>
            <span className="tick" /><span className="ico" aria-hidden="true">⚙︎</span><span className="nm">主机设置…</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}
