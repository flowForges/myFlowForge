import { useEffect, useRef, useState } from 'react'
import type { MobileStatus } from '../../main/host/appGateway'
import { buildPairingLink } from '@shared/remote/pairingLink'
import { QrCode } from './QrCode'
import type { Settings } from '@shared/types'

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
  /**
   * 这台机器的长期身份公钥 + 中转地址 —— 二维码里的 `k` 和 `r`。
   *
   * ★★为什么要单独拉一次而不是从 `MobileStatus` 里拿:身份和中转是**这台机器**的属性,
   *  而 `MobileStatus` 说的是"局域网网关现在什么样"。塞进去的话,一个只开中转、
   *  没开局域网网关的人就拿不到公钥了 —— 而他恰恰是最需要那个二维码的人。
   */
  const [relay, setRelay] = useState<{ publicKey: string; url: string; enabled: boolean; token: string } | null>(null)
  /** 中转连接现在什么样(连上了 / 在重试 / 起不来)。★开关拨过去却什么都没发生,是最难查的一类。 */
  const [relayDetail, setRelayDetail] = useState<{ status: string; error?: string; peers?: number } | null>(null)
  const [relayUrl, setRelayUrl] = useState('')
  const relaySeeded = useRef(false)
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

  // 身份和中转状态跟着走。★`?.` 防御:旧 preload 里没有这几个方法(见下面 `?? ''` 那条同理)。
  useEffect(() => {
    const take = (r: Awaited<ReturnType<NonNullable<typeof window.forge.relayStatus>>> | null) => {
      if (!r) return
      // ★`token` 是中转那条路上用的那把(`relayController.ts` 里就是 `ensureToken()`)。
      //  它和局域网非回环时是**同一把** —— 一枚码要在两条路上都能用,见下面 `qrToken`。
      setRelay({ publicKey: r.publicKey ?? '', url: r.url ?? '', enabled: !!r.enabled, token: r.token ?? '' })
      setRelayDetail((r.detail ?? null) as { status: string; error?: string; peers?: number } | null)
      // ★只在**第一次**回填输入框。之后每一次状态广播都回填的话,人正打到一半的地址会被推回去
      //  —— 和上面那个 `seeded` 是同一条规矩(端口输入框栽过一次)。
      if (!relaySeeded.current) { relaySeeded.current = true; setRelayUrl(r.url ?? '') }
    }
    void window.forge.relayStatus?.().then(take)
    return window.forge.onRelayStatus?.(take)
  }, [])

  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(''), 1600)
  }

  if (!st) return null
  const host = lan ? '0.0.0.0' : '127.0.0.1'
  const portNum = Number(port) || 6789
  // 手机要照抄的地址。虚拟网卡(Parallels / Docker)已经在主进程那边排到后面了 —— 手机连不上那些。
  const lanAddr = st.addresses[0] ?? ''
  const addr = `${lanAddr || '<这台机器的地址>'}:${st.port}`

  /**
   * 中转**真的**开着 —— 开关和地址两样都要。
   * ★只拨了开关没填地址时,`relayController` 停在「没有填中转地址」,它连不上任何地方;
   *  那种状态下出码,只会让人扫进一个死胡同。
   */
  const relayOn = !!relay?.enabled && !!relay.url
  /**
   * ★★出码那一整块的条件。原来是光秃秃一个 `st.running` —— 于是在第二台电脑上**只开中转**的人
   *  整屏找不到「显示配对二维码」,手机根本没法配对(2026-08-31 真机撞到)。
   *  而设计文档决策 6 写得很明确:直连和中转是**平级**的两条路。
   *  只开中转的那个人,恰恰是最需要这枚码的 —— 他没有第二条路可走(公钥手打不出来)。
   */
  const pairable = st.running || relayOn
  /**
   * 码里那个地址。★**不能**是 `<这台机器的地址>` 那串占位符:手机端 `add-host` 保存前一律走
   *  `parseAddress`(走中转也要过那道校验),占位符过不去,现象是「扫进去了,但按不动保存」。
   * ★一个局域网地址都没有时填回环:走中转的手机根本不看这个字段(它按 `r` 拨号),
   *  而以后局域网网关真开起来时,这个地址正好是对的。
   */
  const qrAddr = lanAddr ? `${lanAddr}:${st.port}` : `127.0.0.1:${st.port}`
  /**
   * 码里那把令牌。
   * ★网关绑回环时 `st.token` 是空串 —— 那条路本来就不要令牌(`appGateway.ts:84`)。
   *  但**中转那条路一定要**:`relayController` 起 relayHost 时传的是 `ensureToken()`。
   *  不把它顶上来的话,手机走中转会在握手之后被 4403 断掉,而界面上只写着「连接失败」。
   * ★中转关着时**不顶** —— 那时候多带一把没人校验的令牌,等于白白把钥匙画进码里。
   */
  const qrToken = st.token || (relayOn ? relay?.token ?? '' : '')
  // ★`?? ''` 不是多余的防御:这份 status 是**跨进程**来的,连着一台跑旧版本的主机时
  //  就是少几个字段。少一个字段不该让整屏设置炸成白板(旧 preload 那次已经教过一遍)。
  const pairing = buildPairingLink({
    address: qrAddr,
    token: qrToken,
    label: st.name ?? '',
    // ★公钥只要有就带上,**不看中转开没开** —— 直连那条路现在也加密。
    //  (2026-09-02:`gateway.ts` 加了服务端首帧嗅探握手之前,带公钥的码在局域网上是**连不上**的,
    //   所以这里一度只在开中转时才带。那个临时补丁已经删掉;两端都要 ≥ 这一版。)
    pubKey: relay?.publicKey || undefined,
    // ★中转地址只在**真的开着**的时候带。关着还带的话,手机会拨一个没人应答的地方,
    //  然后停在"连接中"—— 比直接走局域网糟得多。
    relay: relayOn ? relay?.url : undefined,
  })

  return (
    <>
      <div className="set-row">
        <div className="info">
          <div className="t">让手机连进来</div>
          <div className="d">手机上答掉的门,这边的卡片当场消失 —— 同一份核心。</div>
        </div>
        <button
          className={`toggle${st.running ? ' on' : ''}`}
          aria-label="让手机连进来"
          disabled={busy}
          onClick={() => void apply({ enabled: !st.running, host, port: portNum })}
        />
      </div>

      {/* ★起失败要说出来。开关拨过去了却什么也没在听,是最难查的一类 —— 端口被占最常见。 */}
      {st.error && <p className="hosts-formerr">没能启动:{st.error}</p>}

      {/* ★「我手机到底连上没有」的答案必须在**开关旁边**。
          第一版这句话埋在二维码下面,用户手机连上了、翻到这一屏,看见的是一张灰的「本机」卡,
          于是问「本机是灰的,这是什么意思」—— 唯一的证据滚在视野之外。 */}
      {st.running && (
        <div className={`hosts-live ${st.clients > 0 ? 'on' : ''}`}>
          <span className="dot" />
          <span>
            {st.clients > 0
              ? <>现在连着 <b>{st.clients}</b> 台设备</>
              : <>在 <b>{addr}</b> 上等着,还没有设备连上来</>}
          </span>
        </div>
      )}

      {/* ── 中转 ────────────────────────────────────────────────────────────
          ★★和上面那个开关**不是二选一**,所以它就摆在旁边、同一个层级,不藏进"高级"。
           设计文档决策 6 说得很明确:直连(公网 IP / Tailscale / frp / 端口转发)
           和中转是**平级**的两条路 —— 两条走同一套端到端加密,直连还少一跳。
           把直连藏起来会让人以为"必须先部署一台中转才能出门用",而那不是真的。 */}
      <div className="set-row">
        <div className="info">
          <div className="t">出门也能连(中转)</div>
          <div className="d">
            不在同一个 wifi 时走中转。端到端加密,它读不到内容。要<b>你自己部署</b>
            (仓库 <code>relay/</code>)。
          </div>
        </div>
        <button
          className={`toggle${relay?.enabled ? ' on' : ''}`}
          aria-label="出门也能连"
          disabled={busy}
          onClick={() => void window.forge.relayApply?.({ enabled: !relay?.enabled, url: relayUrl.trim() })}
        />
      </div>

      {relay?.enabled && (
      <div className="proj-field">
        <label htmlFor="relayUrl">中转地址</label>
        <div className="hosts-inline">
          <input
            id="relayUrl"
            value={relayUrl}
            placeholder="wss://relay.你的域名/"
            onChange={(e) => setRelayUrl(e.target.value)}
            onBlur={() => {
              if (relay?.enabled && relayUrl.trim() !== relay.url) {
                void window.forge.relayApply?.({ enabled: true, url: relayUrl.trim() })
              }
            }}
          />
        </div>
      </div>
      )}

      {/* ★起失败 / 在重试都要说出来,而且要说人话。 */}
      {relay?.enabled && relayDetail && relayDetail.status !== 'online' && (
        <p className="hosts-formerr">
          {relayDetail.status === 'failed'
            ? `中转连不上:${relayDetail.error ?? '不知道为什么'}`
            : relayDetail.status === 'retrying'
              ? `中转断了,正在重连:${relayDetail.error ?? ''}`
              : '正在连中转…'}
        </p>
      )}
      {relay?.enabled && relayDetail?.status === 'online' && (
        <div className={`hosts-live ${(relayDetail.peers ?? 0) > 0 ? 'on' : ''}`}>
          <span className="dot" />
          <span>
            {(relayDetail.peers ?? 0) > 0
              ? <>通过中转连着 <b>{relayDetail.peers}</b> 台设备</>
              : <>已挂在中转上,等设备连过来</>}
          </span>
        </div>
      )}

      {pairable && (
        <div className="hosts-conn">

          <div className="hosts-qr">
            {showQr ? (
              <>
                {/* alt 报的是**码里真的那个地址**(`qrAddr`),不是上面那个给人抄的 `addr` ——
                    没有局域网地址时那一个是占位符,而占位符从来没进过码。 */}
                <QrCode text={pairing} alt={`配对二维码 · ${qrAddr}`} />
                <div className="hosts-qr-say">
                  <p className="set-desc">
                    用<b>手机自带的相机</b>扫一下就行(不用先打开 app)。
                    ★<b>码里带着这台机器的令牌</b> —— 共享屏幕、录屏、发截图之前先收起来。
                  </p>
                  <button className="set-btn" onClick={() => setShowQr(false)}>收起二维码</button>
                </div>
              </>
            ) : (
              <button className="set-btn" onClick={() => setShowQr(true)}>显示配对二维码</button>
            )}
            {/* ★★2026-09-02:**另一台电脑**也能连进来了(设置 → 远程主机 → 粘贴配对码),
                而电脑之间没法扫码。所以同一枚码要能以**文本**形式拿走。
                ★和二维码同一条安全规矩:这串里带着令牌,复制之后别贴进聊天记录。
                ★只在码展开时摆 —— 折着的时候摆一颗「复制」,等于遮罩根本不存在。 */}
            {showQr && (
              <button className="set-btn" onClick={() => copy('pair', pairing)}>
                {copied === 'pair' ? '已复制(含令牌)' : '复制配对码'}
              </button>
            )}
          </div>

          {/* ★★这句话按中转开没开分岔。原来只有下面那一句「要在同一个网络里」,而中转开着时
              它是**错的** —— 中转存在的全部意义就是两边不在一个网络里也能连。 */}
          {relayOn ? (
            <p className="set-desc">
              走中转时两边<b>可以各在各的网</b>{st.running && ',在一个 wifi 里时自动走局域网直连'}。
            </p>
          ) : (
            <p className="set-desc">
              要在<b>同一个网络</b>里(公司 guest 网多半不通,开个人热点最省事)。出门连走中转。
            </p>
          )}
        </div>
      )}


      {/* ── 高级 ──────────────────────────────────────────────────────────
          ★★2026-09-02 用户原话:「又乱又杂,还有很多文案,都不知道怎么配置了」。
           这一节原来是**平铺**的:主开关、局域网可见、端口、中转、地址、令牌、二维码、
           推送……七个开关四个输入框二十多段说明排成一列,而其中真正要**每次**碰的只有两样:
           打开那个开关、扫那枚码。剩下的全是「配错了或者出问题时才来动」的东西。
          ★所以它们收进这里,**一个都没删** —— 端口被占、只想绑回环、令牌泄了要换、
           相机坏了要手填,这些路都还在,只是不再挡在正常人的路上。
          ★`<details>` 而不是自己写折叠:它自带键盘可达和无障碍语义,而且**默认收起**
           这件事由浏览器保证,不靠我们的初始 state 写对。 */}
      <details className="hosts-adv">
        <summary>高级 —— 端口、绑定、令牌、手填地址</summary>

        <div className="set-row">
          <div className="info">
            <div className="t">局域网可见</div>
            <div className="d">关掉就只绑回环(手机连不上,留给 SSH 隧道)。开着<b>强制令牌</b>。</div>
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
        <>
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
        </>
        )}

        {/* ★这颗和「局域网可见」放一起:换令牌之后,已经配好的手机全部要重新扫码。 */}
        {/* ★仍然挂在 `st.running` 上,**不是**疏漏:`mobileRegenToken` 换的是这台机器那把
            共用令牌,而中转那条连接是**起的时候**就把旧令牌捧在手里的(`relayController` 把
            `ensureToken()` 传给了 `startRelayHost`)—— 换完之后中转那头仍旧认旧的,
            直到中转重连一次。做成「点了要么没生效、要么把手机踢下线」的按钮不如先不摆。 */}
        {st.running && st.token && (
          <div className="hosts-conn-foot">
            <button className="set-btn danger" disabled={busy} onClick={() => void window.forge.mobileRegenToken().then(setSt)}>
              换一把令牌
            </button>
            <span className="set-desc">令牌泄了就换 —— 换完已配好的手机要重新填一次。</span>
          </div>
        )}
      </details>

    </>
  )
}
