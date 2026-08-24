import { useEffect, useRef, useState } from 'react'
import type { MobileStatus } from '../../main/host/appGateway'

/**
 * 「让手机连进来」。
 *
 * ★这不是「再起一个 daemon」的快捷方式 —— 网关端在**这个 app 进程里**,
 *  手机因此和本机窗口共用同一份核心:同一张权限门表、同一份会话状态。
 *  另起 `daemon.js` 也能让手机连上,但那是第二个独立核心,两边互相看不见对方做了什么
 *  (手机答掉的门,电脑上那张卡不会消失)。
 *
 * 它和这一屏的另一半正好是反向的:上面是「这台机器连出去」,这里是「别的设备连进来」。
 */
export function MobileSection() {
  const [st, setSt] = useState<MobileStatus | null>(null)
  const [port, setPort] = useState('6789')
  const [lan, setLan] = useState(true)
  const [showToken, setShowToken] = useState(false)
  const [copied, setCopied] = useState('')
  const [busy, setBusy] = useState(false)
  const seeded = useRef(false)

  useEffect(() => {
    // 先订阅再拉快照(同 HostsPane):否则刚开完开关,一个更旧的快照会把「已启动」盖回去。
    // ★这一节被塞进一个已经存在的面板里。少一个 API(旧 preload、宠物窗那种精简面)
    //  不该把整屏设置炸成白板 —— 那时该做的是安静地不显示。
    if (typeof window.forge?.mobileStatus !== 'function') return
    let pushed = false
    const off = window.forge.onMobileStatus?.((s) => { pushed = true; setSt(s) }) ?? (() => {})
    void window.forge.mobileStatus().then((s) => {
      if (!pushed) setSt(s)
      if (!seeded.current) { seeded.current = true; setPort(String(s.port)); setLan(s.host !== '127.0.0.1') }
    })
    return off
  }, [])

  const apply = async (next: { enabled: boolean; host: string; port: number }) => {
    setBusy(true)
    try { setSt(await window.forge.mobileApply(next)) } finally { setBusy(false) }
  }

  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(''), 1600)
  }

  if (!st) return null
  const host = lan ? '0.0.0.0' : '127.0.0.1'
  const portNum = Number(port) || 6789
  // 手机要照抄的地址。虚拟网卡(Parallels / Docker)已经在主进程那边排到后面了 —— 手机连不上那些。
  const first = st.addresses[0] ?? '<这台机器的地址>'

  return (
    <>
      <div className="set-row">
        <div className="grow">
          <div className="set-label">让手机连进来</div>
          <div className="set-desc">
            手机 app 直接连这个 app —— <b>同一份核心</b>,所以手机上答掉的门,这边的卡片当场消失。
          </div>
        </div>
        <label className="set-switch">
          <input
            type="checkbox"
            checked={st.running}
            disabled={busy}
            onChange={(e) => void apply({ enabled: e.target.checked, host, port: portNum })}
          />
          <span />
        </label>
      </div>

      {/* ★起失败要说出来。开关拨过去了却什么也没在听,是最难查的一类 —— 端口被占最常见。 */}
      {st.error && <p className="hosts-formerr">没能启动:{st.error}</p>}

      <label className="proj-field">
        <span>端口</span>
        <input
          value={port}
          inputMode="numeric"
          onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
          onBlur={() => { if (st.running) void apply({ enabled: true, host, port: portNum }) }}
        />
      </label>

      <label className="set-row">
        <div className="grow">
          <div className="set-label">局域网可见</div>
          <div className="set-desc">
            关掉就只绑回环,手机连不上(留给 SSH 隧道)。开着<b>强制令牌</b> ——
            这个端口能起 agent、替你答权限门、开终端,等于整台机器的控制权。
          </div>
        </div>
        <input
          type="checkbox"
          checked={lan}
          disabled={busy}
          onChange={(e) => { setLan(e.target.checked); if (st.running) void apply({ enabled: true, host: e.target.checked ? '0.0.0.0' : '127.0.0.1', port: portNum }) }}
        />
      </label>

      {st.running && (
        <div className="hosts-io">
          <p className="set-desc full">在手机上「添加主机」填这两样:</p>
          <label className="proj-field">
            <span>地址</span>
            <input readOnly value={`${first}:${st.port}`} onFocus={(e) => e.currentTarget.select()} />
            <button className="set-btn" onClick={() => copy('addr', `${first}:${st.port}`)}>
              {copied === 'addr' ? '已复制' : '复制'}
            </button>
          </label>
          {st.addresses.length > 1 && (
            <p className="set-desc full">
              这台机器还有别的地址:{st.addresses.slice(1).map((a) => `${a}:${st.port}`).join('  ')}
              —— 用和手机<b>在同一个网段</b>的那个。
            </p>
          )}
          {st.token && (
            <label className="proj-field">
              <span>访问令牌</span>
              <input readOnly type={showToken ? 'text' : 'password'} value={st.token} onFocus={(e) => e.currentTarget.select()} />
              <button className="set-btn" onClick={() => setShowToken((v) => !v)}>{showToken ? '隐藏' : '显示'}</button>
              <button className="set-btn" onClick={() => copy('token', st.token)}>
                {copied === 'token' ? '已复制' : '复制'}
              </button>
            </label>
          )}
          <p className="set-desc full">
            当前连着 <b>{st.clients}</b> 台设备。
            {st.token && (
              <>
                {' '}令牌泄了就
                <button className="set-btn danger" style={{ marginLeft: 6 }} disabled={busy} onClick={() => void window.forge.mobileRegenToken().then(setSt)}>
                  换一把
                </button>
                {' '}—— 换完已配好的手机要重新填一次。
              </>
            )}
          </p>
          <p className="set-desc full">
            手机和这台电脑要在<b>同一个网络</b>里。公司 guest 网基本都开客户端隔离,连不通;
            最省事的办法是<b>手机开个人热点、这台电脑连手机</b>(那样两边的流量走本地链路,不吃流量)。
          </p>
        </div>
      )}
    </>
  )
}
