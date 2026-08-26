import { useEffect, useRef, useState } from 'react'
import type { MobileStatus } from '../../main/host/appGateway'
import { buildPairingLink } from '@shared/remote/pairingLink'
import { QrCode } from './QrCode'

/**
 * 「让手机连进来」。
 *
 * ★这不是「再起一个 daemon」的快捷方式 —— 网关端在**这个 app 进程里**,
 *  手机因此和本机窗口共用同一份核心:同一张权限门表、同一份会话状态。
 *  另起 `daemon.js` 也能让手机连上,但那是第二个独立核心,两边互相看不见对方做了什么
 *  (手机答掉的门,电脑上那张卡不会消失)。
 *
 * 它和这一屏的另一半正好是反向的:上面是「这台机器连出去」,这里是「别的设备连进来」。
 *
 * ★样式一律用设置面板已有的那套(.set-row/.info/.t/.d + .toggle + .proj-field>label),
 *  不要再自造 class 名。第一版写了 .set-label/.set-switch/.grow 三个**根本不存在**的 class,
 *  于是标签全掉回默认字号(比邻居大一号)、开关退化成系统原生复选框 —— 用户一眼就看出来了。
 */
export function MobileSection() {
  const [st, setSt] = useState<MobileStatus | null>(null)
  const [port, setPort] = useState('6789')
  const [lan, setLan] = useState(true)
  const [showToken, setShowToken] = useState(false)
  // ★码里带着令牌 —— 那等于把机器钥匙画在屏幕上。默认折起来,别在共享屏幕/录屏时替人做主。
  const [showQr, setShowQr] = useState(false)
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
  const addr = `${first}:${st.port}`
  // ★`?? ''` 不是多余的防御:这份 status 是**跨进程**来的,连着一台跑旧版本的主机时
  //  就是少几个字段。少一个字段不该让整屏设置炸成白板(旧 preload 那次已经教过一遍)。
  const pairing = buildPairingLink({ address: addr, token: st.token ?? '', label: st.name ?? '' })

  return (
    <>
      <div className="set-row">
        <div className="info">
          <div className="t">让手机连进来</div>
          <div className="d">
            手机 app 直接连这个 app —— <b>同一份核心</b>,所以手机上答掉的门,这边的卡片当场消失。
          </div>
        </div>
        <button
          className={`toggle${st.running ? ' on' : ''}`}
          aria-label="让手机连进来"
          disabled={busy}
          onClick={() => void apply({ enabled: !st.running, host, port: portNum })}
        />
      </div>

      <div className="set-row">
        <div className="info">
          <div className="t">局域网可见</div>
          <div className="d">
            关掉就只绑回环,手机连不上(留给 SSH 隧道)。开着<b>强制令牌</b> ——
            这个端口能起 agent、替你答权限门、开终端,等于整台机器的控制权。
          </div>
        </div>
        <button
          className={`toggle${lan ? ' on' : ''}`}
          aria-label="局域网可见"
          disabled={busy}
          onClick={() => {
            const next = !lan
            setLan(next)
            if (st.running) void apply({ enabled: true, host: next ? '0.0.0.0' : '127.0.0.1', port: portNum })
          }}
        />
      </div>

      {/* ★起失败要说出来。开关拨过去了却什么也没在听,是最难查的一类 —— 端口被占最常见。 */}
      {st.error && <p className="hosts-formerr">没能启动:{st.error}</p>}

      <div className="proj-field hosts-port">
        <label htmlFor="mobPort">端口</label>
        <input
          id="mobPort"
          value={port}
          inputMode="numeric"
          onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
          onBlur={() => { if (st.running) void apply({ enabled: true, host, port: portNum }) }}
        />
      </div>

      {st.running && (
        <div className="hosts-conn">
          <p className="set-desc">在手机上「添加主机」填这两样:</p>

          <div className="proj-field">
            <label htmlFor="mobAddr">地址</label>
            <div className="hosts-inline">
              <input id="mobAddr" readOnly value={addr} onFocus={(e) => e.currentTarget.select()} />
              <button className="set-btn" onClick={() => copy('addr', addr)}>
                {copied === 'addr' ? '已复制' : '复制'}
              </button>
            </div>
          </div>

          {st.addresses.length > 1 && (
            <p className="set-desc">
              这台机器还有别的地址:{st.addresses.slice(1).map((a) => `${a}:${st.port}`).join('  ')}
              {' '}—— 用和手机<b>在同一个网段</b>的那个。
            </p>
          )}

          {st.token && (
            <div className="proj-field">
              <label htmlFor="mobToken">访问令牌</label>
              <div className="hosts-inline">
                <input id="mobToken" readOnly type={showToken ? 'text' : 'password'} value={st.token} onFocus={(e) => e.currentTarget.select()} />
                <button className="set-btn" onClick={() => setShowToken((v) => !v)}>{showToken ? '隐藏' : '显示'}</button>
                <button className="set-btn" onClick={() => copy('token', st.token)}>
                  {copied === 'token' ? '已复制' : '复制'}
                </button>
              </div>
            </div>
          )}

          <div className="hosts-qr">
            {showQr ? (
              <>
                <QrCode text={pairing} alt={`配对二维码 · ${addr}`} />
                <div className="hosts-qr-say">
                  <p className="set-desc">
                    用<b>手机自带的相机</b>对着它扫一下(不用先打开 app),点弹出来的横幅 ——
                    myFlowForge 会打开,地址和令牌都已经填好了。app 里「添加主机 → 扫一扫」也扫这枚。
                  </p>
                  <p className="set-desc">
                    ★<b>这枚码里带着上面那把令牌</b>,谁扫到谁就拿到这台机器的控制权。
                    共享屏幕、录屏、发截图之前先把它收起来。
                  </p>
                  <button className="set-btn" onClick={() => setShowQr(false)}>收起二维码</button>
                </div>
              </>
            ) : (
              <button className="set-btn" onClick={() => setShowQr(true)}>显示配对二维码</button>
            )}
          </div>

          <div className="hosts-conn-foot">
            <span className="set-desc">当前连着 <b>{st.clients}</b> 台设备</span>
            {st.token && (
              <button className="set-btn danger" disabled={busy} onClick={() => void window.forge.mobileRegenToken().then(setSt)}>
                换一把令牌
              </button>
            )}
          </div>
          {st.token && <p className="set-desc">令牌泄了就换一把 —— 换完已配好的手机要重新填一次。</p>}

          <p className="set-desc">
            手机和这台电脑要在<b>同一个网络</b>里。公司 guest 网基本都开客户端隔离,连不通;
            最省事的办法是<b>手机开个人热点、这台电脑连手机</b>(那样两边的流量走本地链路,不吃流量)。
          </p>
        </div>
      )}
    </>
  )
}
