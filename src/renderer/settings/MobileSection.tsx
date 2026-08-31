import { useEffect, useRef, useState } from 'react'
import type { MobileStatus } from '../../main/host/appGateway'
import { buildPairingLink } from '@shared/remote/pairingLink'
import { QrCode } from './QrCode'
import type { PushDevice } from '../../main/push/pushStore'
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
  /** 已经登记要收推送的手机。★这张表存在**当前连着的那台机器**上 —— 发推送的是它。 */
  const [devices, setDevices] = useState<PushDevice[] | null>(null)
  const [pushCfg, setPushCfg] = useState<Settings['push'] | null>(null)
  const [pushMsg, setPushMsg] = useState('')

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

  // 推送:设备表 + 那台机器上的开关。★两样都可能不存在(老 daemon / 老 preload),
  //  少一个 API 不该把整屏设置炸成白板 —— 安静地不显示就好。
  const loadPush = () => {
    if (typeof window.forge?.pushDevices !== 'function') return
    void window.forge.pushDevices().then(setDevices).catch(() => setDevices([]))
    void window.forge.getSettings().then((raw) => {
      const p = (raw as Settings | null)?.push
      if (p) setPushCfg(p)
    }).catch(() => {})
  }
  useEffect(loadPush, [])

  const savePush = async (next: Settings['push']) => {
    setPushCfg(next)
    const cur = (await window.forge.getSettings()) as Settings
    await window.forge.setSettings({ ...cur, push: next })
  }

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
    // ★★公钥**只要有就带上**,不看中转开没开:带上它的意思是"这条链路可以端到端加密",
    //  而那对直连一样成立(而且直连也该加密 —— 同一套代码,少一跳)。
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

      {/* ── 中转 ────────────────────────────────────────────────────────────
          ★★和上面那个开关**不是二选一**,所以它就摆在旁边、同一个层级,不藏进"高级"。
           设计文档决策 6 说得很明确:直连(公网 IP / Tailscale / frp / 端口转发)
           和中转是**平级**的两条路 —— 两条走同一套端到端加密,直连还少一跳。
           把直连藏起来会让人以为"必须先部署一台中转才能出门用",而那不是真的。 */}
      <div className="set-row">
        <div className="info">
          <div className="t">出门也能连(中转)</div>
          <div className="d">
            不在同一个 wifi 时走一台<b>你自己部署的</b>中转服务器。
            它是个<b>哑管道</b> —— 整条链路端到端加密,它读不到任何内容,也冒充不了这台电脑。
            <br />
            有公网 IP、Tailscale 或者内网穿透的话<b>根本不需要它</b>:直连走同一套加密,还少一跳。
          </div>
        </div>
        <button
          className={`toggle${relay?.enabled ? ' on' : ''}`}
          aria-label="出门也能连"
          disabled={busy}
          onClick={() => void window.forge.relayApply?.({ enabled: !relay?.enabled, url: relayUrl.trim() })}
        />
      </div>

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
      <p className="set-desc">
        中转要自己部署 —— 代码在仓库的 <code>relay/</code> 里,Docker 一条命令。
        <b>不提供官方中转</b>:那样所有人的流量都要经过我们,哪怕读不到内容也不该那样。
      </p>

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
          {/* ★★手填用的那两个框只在**局域网网关开着**时摆。
              纯中转时手填是走不通的:配对码里的公钥(`k`)是整条链路唯一的信任锚点,而它
              **没有输入框**(见 `mobile/app/add-host.tsx`:公钥和中转地址只读、不给人改)——
              手打一把 44 字符的 base64 既没人核对得了,错一个字符也只会静默连不上。
              照旧摆出来的话,人会照着填,然后得到一条**直连**记录、去连一个根本没开的网关。 */}
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

          {/* 纯中转时,「怎么配对」只有一条路,得说出来 —— 否则人会去找那两个不见了的输入框。 */}
          {!st.running && (
            <p className="set-desc">
              现在只开着中转,所以配对<b>只能扫码</b> —— 码里那把身份公钥没有输入框(手打一把
              44 个字符的 base64,错一个字符只会静默连不上)。手填出来的记录是<b>直连</b>,
              会去连一个没开着的网关。
            </p>
          )}

          <div className="hosts-qr">
            {showQr ? (
              <>
                {/* alt 报的是**码里真的那个地址**(`qrAddr`),不是上面那个给人抄的 `addr` ——
                    没有局域网地址时那一个是占位符,而占位符从来没进过码。 */}
                <QrCode text={pairing} alt={`配对二维码 · ${qrAddr}`} />
                <div className="hosts-qr-say">
                  <p className="set-desc">
                    用<b>手机自带的相机</b>对着它扫一下(不用先打开 app),点弹出来的横幅 ——
                    myFlowForge 会打开,地址和令牌都已经填好了。app 里「添加主机 → 扫一扫」也扫这枚。
                  </p>
                  {/* ★「上面那把」只有在上面**真的摆着**令牌框时才说得通(纯中转时那个框不在)。 */}
                  <p className="set-desc">
                    ★<b>这枚码里带着{st.running && st.token ? '上面那把' : '这台机器的'}令牌</b>,
                    谁扫到谁就拿到这台机器的控制权。共享屏幕、录屏、发截图之前先把它收起来。
                  </p>
                  <button className="set-btn" onClick={() => setShowQr(false)}>收起二维码</button>
                </div>
              </>
            ) : (
              <button className="set-btn" onClick={() => setShowQr(true)}>显示配对二维码</button>
            )}
          </div>

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

          {/* ★★这句话按中转开没开分岔。原来只有下面那一句「要在同一个网络里」,而中转开着时
              它是**错的** —— 中转存在的全部意义就是两边不在一个网络里也能连。 */}
          {relayOn ? (
            <p className="set-desc">
              走中转时手机和电脑<b>可以各在各的网</b> —— 手机用蜂窝网也连得上。
              {st.running && ' 两边在一个 wifi 里时会走局域网直连(快、少一跳),同一枚码两条路都认。'}
            </p>
          ) : (
            <p className="set-desc">
              手机和这台电脑要在<b>同一个网络</b>里。公司 guest 网基本都开客户端隔离,连不通;
              最省事的办法是<b>手机开个人热点、这台电脑连手机</b>(那样两边的流量走本地链路,不吃流量)。
            </p>
          )}
        </div>
      )}

      {/* ── 推送 ────────────────────────────────────────────────────────────
          ★★手机端存在的意义有一半在这儿:**你不在电脑前,一道门升起来卡在那儿**。
           「能答门」早就做完了,「你怎么知道有门」一直是空的。
          ★★这块**不放在 `st.running` 里面**:推送和局域网网关开没开完全无关 ——
           走中转连进来的手机同样要收推送,而那种人的局域网网关多半是关着的。
          ★决策 7:这台机器直接 POST 给 Expo,不经中转、不用自建后端。
           代价是正文明文过 Expo/APNs,所以推送里**只有工作区名和一句固定的话**,
           一个字的对话内容都没有。 */}
      {pushCfg && (
        <>
          <div className="set-row">
            <div className="info">
              <div className="t">手机不在跟前时推送给它</div>
              <div className="d">
                门升起来 / 一轮跑完时,这台机器直接推到你手机上。
                <b>手机 app 开着的时候不推</b> —— 那种情况它自己会弹一条,不会响两遍。
              </div>
            </div>
            <button
              className={`toggle${pushCfg.enabled ? ' on' : ''}`}
              aria-label="推送到手机"
              onClick={() => void savePush({ ...pushCfg, enabled: !pushCfg.enabled })}
            />
          </div>

          <div className="set-row" style={{ opacity: pushCfg.enabled ? 1 : 0.45 }}>
            <div className="info">
              <div className="t">需要你答的门</div>
              <div className="d">权限门、代理提问、工作流卡住 —— 没你就一直停在那儿的那些</div>
            </div>
            <button
              className={`toggle${pushCfg.gate ? ' on' : ''}`}
              aria-label="推送门"
              disabled={!pushCfg.enabled}
              onClick={() => void savePush({ ...pushCfg, gate: !pushCfg.gate })}
            />
          </div>

          <div className="set-row" style={{ opacity: pushCfg.enabled ? 1 : 0.45 }}>
            <div className="info">
              <div className="t">跑完了</div>
              <div className="d">默认关 —— 半夜被一条「跑完了」吵醒一次,这个功能就会被整个关掉</div>
            </div>
            <button
              className={`toggle${pushCfg.done ? ' on' : ''}`}
              aria-label="推送完成"
              disabled={!pushCfg.enabled}
              onClick={() => void savePush({ ...pushCfg, done: !pushCfg.done })}
            />
          </div>

          {/* ★设备表 = 「到底有没有手机真的登记上」的唯一证据。空表和「推送开着」并存
              是最容易被误读成"已经在用了"的状态,所以空态要**说下一步该做什么**。 */}
          <div className="hosts-conn">
            {devices && devices.length > 0 ? (
              <>
                <p className="set-desc">已经登记的手机:</p>
                {devices.map((d) => (
                  <div className="set-row" key={d.token}>
                    <div className="info">
                      <div className="t">{d.label || (d.platform === 'android' ? 'Android 手机' : 'iPhone')}</div>
                      <div className="d">
                        最近一次连上:{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '还没有'}
                      </div>
                    </div>
                    <button
                      className="set-btn danger"
                      onClick={() => void window.forge.pushUnregister(d.token).then(setDevices)}
                    >
                      不再推送
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <p className="set-desc">
                还没有手机登记过推送。在手机上打开 <b>设置 → 提醒 → 有事就提醒我</b>,
                它会把自己登记到这台机器上。
              </p>
            )}

            <div className="hosts-conn-foot">
              <button
                className="set-btn"
                onClick={() => {
                  setPushMsg('发送中…')
                  void window.forge.pushTest()
                    .then((r) => setPushMsg(
                      r.sent > 0
                        ? `发出去 ${r.sent} 条。手机上没看到的话,多半是通知权限没给。`
                        : `一条都没发出去:${r.errors[0] ?? '不知道为什么'}`))
                    .catch((e: unknown) => setPushMsg(`发不出去:${e instanceof Error ? e.message : String(e)}`))
                    .finally(loadPush)
                }}
              >
                发一条测试推送
              </button>
              <button className="set-btn" onClick={loadPush}>刷新</button>
              {pushMsg && <span className="set-desc">{pushMsg}</span>}
            </div>

            {/* ★★这一句是「远程推送到底能不能用」的诚实交代。
                Expo 的推送令牌要一个 Expo 项目 + 上传好的 APNs/FCM 凭据,而那要用**你自己的**
                Expo 账号 —— 我配不了。没配的时候手机端仍然有一半提醒可用(app 开着那一半),
                所以这里说的是「差哪一步」,不是「不支持」。 */}
            <p className="set-desc">
              ★手机在<b>后台</b>时收到的那条,走的是 Expo 的推送服务,要先
              <code>npx eas-cli init</code> 建一个 Expo 项目,再
              <code>npx eas-cli credentials</code> 传一次凭据。
              <b>安卓只要这两步</b>(传 FCM),和苹果账号无关。
            </p>
            <p className="set-desc">
              ★★<b>iOS 还要一个付费的 Apple Developer Program($99/年)</b> ——
              Push Notifications 是付费会员才有的能力,免费 Apple ID(描述文件 7 天过期的那种)
              开不了。齐了之后在 <code>mobile/app.json</code> 的 <code>extra</code> 里加
              <code>"iosPush": true</code>。
              ★<b>在这之前不要手动去动 entitlements</b>:没有那个能力却带着
              <code>aps-environment</code>,Release 包会直接签名失败。
            </p>
            <p className="set-desc">
              这一步之前,手机 app <b>开着</b>的时候提醒照常有,切走之后收不到。
            </p>
          </div>
        </>
      )}
    </>
  )
}
