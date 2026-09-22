import { useEffect, useRef, useState } from 'react'
import type { MobileStatus } from '../../main/host/appGateway'
import type { AuthorizedDevice } from '../../main/remote/deviceTokens'
import { buildPairingLink } from '@shared/remote/pairingLink'
import { QrCode } from './QrCode'
import { RelayUrlPicker } from './RelayUrlPicker'
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
  const [relay, setRelay] = useState<{ publicKey: string; url: string; enabled: boolean; urlHistory?: string[] } | null>(null)
  /** 中转连接现在什么样(连上了 / 在重试 / 起不来)。★开关拨过去却什么都没发生,是最难查的一类。 */
  const [relayDetail, setRelayDetail] = useState<
    { status: string; error?: string; peers?: number; devices?: { cid: string; label: string; since: number; deviceId?: string }[] } | null
  >(null)
  /** 正在踢的那台 —— 点完到状态回来之间要把按钮按住,否则连点两下会发两次。 */
  const [kicking, setKicking] = useState('')
  /**
   * 这次要给出去的配对令牌。★按设备发(main/remote/deviceTokens.ts):每台设备一把,可以单独移除。
   *  只在点「生成配对码」时才去要 —— 打开设置页不该凭空多出一台「等待配对」。
   */
  const [pair, setPair] = useState<{ id: string; token: string } | null>(null)
  /** 已授权设备(含离线的)。「移除」在这里,「断开」在下面的已连接列表里。 */
  const [authorized, setAuthorized] = useState<AuthorizedDevice[]>([])
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
      // ★★`urlHistory` 必须一起拷进来。09-17 那一版这里只拷了四个字段 —— 主进程明明存着历史,
      //  界面上的下拉却永远是空的,功能做完那天起就没用过。
      setRelay({ publicKey: r.publicKey ?? '', url: r.url ?? '', enabled: !!r.enabled, urlHistory: r.urlHistory ?? [] })
      setRelayDetail((r.detail ?? null) as {
        status: string; error?: string; peers?: number
        devices?: { cid: string; label: string; since: number; deviceId?: string }[]
      } | null)
    }
    void window.forge.relayStatus?.().then(take)
    return window.forge.onRelayStatus?.(take)
  }, [])

  useEffect(() => {
    if (typeof window.forge?.devicesList !== 'function') return
    void window.forge.devicesList().then(setAuthorized)
    return window.forge.onDevicesChanged?.(setAuthorized)
  }, [])

  const newPairing = async () => {
    setPair(await window.forge.devicesPairing())
    setShowQr(true)
  }
  /** 永久移除:令牌作废 + 当场断开,对方不会自动重连。 */
  const revoke = (d: { id: string; legacy?: boolean; label?: string }) => {
    const what = d.legacy
      ? '撤销旧配对码?\n升级前用它配对的所有设备都会立刻断开、且连不回来,要继续用的得重新配对。'
      : `移除「${d.label || '这台设备'}」?\n它会立刻断开,而且连不回来 —— 要再连得重新配对。`
    if (!window.confirm(what)) return
    void window.forge.devicesRevoke(d.id).then(setAuthorized)
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
   * ★网关绑回环时那条路本来就不要令牌(`st.tokenRequired` 为 false)。
   *  但**中转那条路一定要** —— 不带的话手机走中转会在握手之后被 4403 断掉,界面上只写着「连接失败」。
   * ★两条路都不要令牌时**不带** —— 多带一把没人校验的令牌,等于白白把钥匙画进码里。
   */
  // ★按设备发的那把(只要这条路需要令牌就带):局域网绑非回环要,中转一定要。
  const needToken = st.tokenRequired || relayOn
  const qrToken = needToken ? pair?.token ?? '' : ''
  /** 这枚码已经被某台设备用掉了 ⇒ 给下一台得再生成一枚。 */
  const pairUsedBy = pair ? authorized.find((d) => d.id === pair.id && !d.pending) : undefined
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
      {/* ★★2026-09-17 分节。这一页原来是「开关 → 开关 → …… → 高级」一路平铺,而「高级」里装的
          全是**上面第一个开关的参数**(端口、绑哪个地址、手填地址令牌),它却被摆在最底下、
          跨过了整个中转节 —— 于是读起来像第三个并列项。用户原话:「这个让手机连进来和底部的
          高级 区别在哪?底部的这个高级是干啥的?」。困惑是这个结构造成的,不是他没看懂。
          ★现在:局域网 / 远程连接 各自成节,高级收进它所属的那一节里。 */}
      {/* ★★★配对码提到最前面。它是这一屏**唯一每次都要用**的东西,而且**两条路共用同一枚码** ——
          以前它压在整页最底下、「远程连接」那一节里,于是看着像中转专属的功能
          (用户 2026-09-19:「局域网的连接其实也是扫二维码,但这个二维码又在出门中转的下面」)。
          下面两节回答的是**另一个**问题:这张码里印的地址从哪来(局域网 / 中转)。 */}
      {pairable && (
        <div className="hosts-conn">
          <div className="hosts-qr">
            {showQr && pair ? (
              <>
                {/* alt 报的是**码里真的那个地址**(`qrAddr`),不是上面那个给人抄的 `addr` ——
                    没有局域网地址时那一个是占位符,而占位符从来没进过码。 */}
                <QrCode text={pairing} alt={`配对二维码 · ${qrAddr}`} />
                <div className="hosts-qr-say">
                  {/* ★安全那半句不许压掉:这枚码里带着令牌,是这一屏唯一一条安全提示。 */}
                  {/* ★这一屏唯一一条安全提示,不许压掉。 */}
                  <p className="set-desc">码里带令牌,别截图外传。<b>一枚码只给一台设备</b> —— 这样以后能单独移除它。</p>
                  {pairUsedBy && (
                    <p className="set-desc">这枚码已被「{pairUsedBy.label || '一台设备'}」用了。给下一台:
                      {' '}<button className="set-btn" onClick={() => void newPairing()}>再生成一枚</button>
                    </p>
                  )}
                  <button className="set-btn" onClick={() => setShowQr(false)}>收起二维码</button>
                </div>
              </>
            ) : (
              <button className="set-btn" onClick={() => void newPairing()}>为新设备生成配对码</button>
            )}
            {/* ★★2026-09-02:**另一台电脑**也能连进来了(设置 → 远程主机 → 粘贴配对码),
                而电脑之间没法扫码。所以同一枚码要能以**文本**形式拿走。
                ★和二维码同一条安全规矩:这串里带着令牌,复制之后别贴进聊天记录。
                ★只在码展开时摆 —— 折着的时候摆一颗「复制」,等于遮罩根本不存在。 */}
            {showQr && pair && (
              <button className="set-btn" onClick={() => copy('pair', pairing)}>
                {copied === 'pair' ? '已复制(含令牌)' : '复制配对码'}
              </button>
            )}
          </div>

          {/* ★★这句话按中转开没开分岔。原来只有下面那一句「要在同一个网络里」,而中转开着时
              它是**错的** —— 中转存在的全部意义就是两边不在一个网络里也能连。 */}
          {/* ★★说的是「**这张码里有什么**」,不是泛泛的使用条件。
              这枚码是两条路**共用**的:它编的是地址 + 令牌 + 公钥 +(开了中转的话)中转地址。
              以前这句话跟着码摆在「远程连接」那一节的**下面**,于是读起来像是中转专属的说明,
              而其中「要在同一个网络里」偏偏是在替**局域网**说话 —— 用户 2026-09-19 原话:
              「这个二维码又是在出门中转的下面,这个就让人很奇怪」。错位的是位置,不是他没看懂。 */}
          {relayOn ? (
            <p className="set-desc">码里带中转 —— 对方在哪都能连。</p>
          ) : (
            <p className="set-desc">码里是局域网地址 —— 对方要和这台在同一个网里。</p>
          )}
        </div>
      )}
      {!pairable && (
        <p className="set-desc">下面至少打开一条,才有码。</p>
      )}

      {/* ★★分节标题去掉了。原来是「局域网」一节 +「让设备连进来」一个开关,两层说的是同一件事;
          现在开关自己就叫「局域网」,一行顶两行。用户 2026-09-20:「就三个字,局域网,不要多余的解释」。 */}
      <div className="set-row">
        <div className="info">
          <div className="t">局域网</div>
        </div>
        <button
          className={`toggle${st.running ? ' on' : ''}`}
          aria-label="局域网"
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
        /* ★这一行只回答「它在哪儿听着」。**连了几台、哪几台**统一挪到下面那块设备列表里 ——
           原来局域网这儿只报一个数字、中转那儿报名字带踢人,同一件事两种画法两个位置。 */
        <div className="hosts-live on" data-live="lan">
          <span className="dot" />
          <span className="hl-say"><span className="hl-d">{addr}</span></span>
        </div>
      )}

      {/* ── 中转 ────────────────────────────────────────────────────────────
          ★★和上面那个开关**不是二选一**,所以它就摆在旁边、同一个层级,不藏进"高级"。
           设计文档决策 6 说得很明确:直连(公网 IP / Tailscale / frp / 端口转发)
           和中转是**平级**的两条路 —— 两条走同一套端到端加密,直连还少一跳。
           把直连藏起来会让人以为"必须先部署一台中转才能出门用",而那不是真的。 */}
      {/* ★★2026-09-17 这一块**搬到了「远程连接」之前** —— 它装的全是上面局域网那个开关的
          参数(端口、绑哪个地址、手填地址令牌),所以它属于局域网那一节。原来它浮在整页最底下、
          跨过了整个中转节,读起来像第三个并列项(用户:「这个让手机连进来和底部的高级 区别在哪?」)。 */}
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
        {/* ★★标题写的是**什么时候需要打开它**,不是里面有哪些字段。用户 2026-09-19 原话:
            「局域网里的高级是啥东西,我一直没看明白」—— 原来那行是「端口、绑定、令牌、手填地址」,
            四个名词摆在那儿,没有一个回答「我为什么要点开」。 */}
        <summary>高级 —— 端口被占、只想走 SSH、令牌泄了、地址探测错了</summary>

        <div className="set-row">
          <div className="info">
            <div className="t">局域网可见</div>
            <div className="d">关掉只绑回环(留给 SSH 隧道)。开着<b>强制令牌</b>。</div>
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

        {st.tokenRequired && (pair ? (
          <div className="proj-field">
            <label htmlFor="mobToken">访问令牌</label>
            <div className="hosts-inline">
              <input id="mobToken" readOnly type={showToken ? 'text' : 'password'} value={pair.token} onFocus={(e) => e.currentTarget.select()} />
              <button className="set-btn" onClick={() => setShowToken((v) => !v)}>{showToken ? '隐藏' : '显示'}</button>
              <button className="set-btn" onClick={() => copy('token', pair.token)}>
                {copied === 'token' ? '已复制' : '复制'}
              </button>
            </div>
          </div>
        ) : (
          <p className="set-desc">访问令牌:先在上面点「为新设备生成配对码」—— 每台设备一把。</p>
        ))}
        </>
        )}

        {/* ★「换一把令牌」拿掉了:令牌现在按设备发,泄了就在下面「已授权设备」里移除那一台,
            不知道是哪台就「全部撤销」。原来那颗按钮只往磁盘写一把新令牌,正在跑的网关和中转
            都还认旧的,要重启 app 才生效 —— 点了等于没点(2026-09-22 查出来的)。 */}
      </details>

      {/* ★同上:开关自己就叫「外部中转」,不再顶一个「远程连接」的分节标题。
          「要你自己部署」那句挪进了下面的中转地址那一行 —— 那是**配的时候**才需要知道的事。 */}
      <div className="set-row">
        <div className="info">
          <div className="t">外部中转</div>
        </div>
        <button
          className={`toggle${relay?.enabled ? ' on' : ''}`}
          aria-label="外部中转"
          disabled={busy}
          // 打开时用正在用的地址;没有就拿最近用过的那个 —— 下拉里排第一的就是它。
          onClick={() => void window.forge.relayApply?.({ enabled: !relay?.enabled, url: relay?.url || relay?.urlHistory?.[0] || '' })}
        />
      </div>

      {relay?.enabled && (
      <div className="proj-field">
        <label>中转地址</label>
        {/* ★下拉:点开看全部保存过的地址、点一条切换、× 删一条、「+ 新增地址」。
            理由和取舍见 RelayUrlPicker.tsx 顶部;历史只有地址、没有令牌,见 shared/remote/relayHistory.ts。 */}
        <RelayUrlPicker
          current={relay?.url ?? ''}
          history={relay?.urlHistory ?? []}
          disabled={busy}
          onSwitch={(url) => window.forge.relayApply({ enabled: true, url })}
          onRemember={(url) => window.forge.relayRememberUrl(url)}
          onForget={(url) => window.forge.relayForgetUrl(url)}
        />
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
      {/**
        * ★★★「连着哪几台、能不能把它弄走」—— 用户 2026-09-20 点名要保住的那块。
        *
        *  原来这件事是**两处两种画法**:局域网那儿只有一个数字(`N 台设备连着`),
        *  中转那儿才有名字和「断开」。于是同一个问题的答案,取决于对方是从哪条路进来的。
        *  现在合成一块:**有名字的列名字,没名字的据实说是几台**。
        *
        *  ★局域网那条路拿不到设备名 —— 网关只数连接数(`appGateway.clientCount()`),
        *   它没有中转那条的 `identify` 帧。所以这里**不编名字**:能踢的才给踢的按钮,
        *   踢不了的就不摆一颗点了没反应的键。
        */}
      {(st.running || relay?.enabled) && (() => {
        const relayDevs = relayDetail?.status === 'online' ? (relayDetail.devices ?? []) : []
        const lanDevs = st.running ? (st.devices ?? []) : []
        const lanN = st.running ? st.clients : 0
        // ★还没自报名字的那几条(刚连上、鉴权中)只在计数里,不在名单里。据实说「还有 N 台正在连」,
        //  不编名字,也不把它们算作"不知道是谁" —— 它们很快就会带着名字出现在上面。
        const lanPending = Math.max(0, lanN - lanDevs.length)
        const total = lanN + relayDevs.length
        return (
          <div className="hosts-devs">
            <div className="hd-h">
              已连接的设备
              <span className="hd-n">{total > 0 ? total : '无'}</span>
            </div>
            {total === 0 ? (
              <p className="hd-empty">还没有设备连上来。</p>
            ) : (
              <ul className="hd-list">
                {relayDevs.map((d) => (
                  <li className="hd-row" key={d.cid}>
                    <span className="hd-dot" />
                    <span className="hd-nm" title={d.label}>{d.label}</span>
                    <span className="hd-via">中转</span>
                    <button
                      className="set-btn"
                      disabled={busy || kicking === d.cid}
                      title="断开这一台。它会自己重连 —— 卡住的连接可以用它救回来"
                      onClick={async () => {
                        // ★不接返回值:`relayController.kick` 会 `announce()`,
                        //  新状态从 `onRelayStatus` 那条广播回来 —— 和别处同一条路。
                        setKicking(d.cid)
                        try { await window.forge.relayKick?.(d.cid) }
                        finally { setKicking('') }
                      }}
                    >
                      {kicking === d.cid ? '断开中…' : '断开'}
                    </button>
                    {d.deviceId && <RemoveBtn deviceId={d.deviceId} label={d.label} onRevoke={revoke} />}
                  </li>
                ))}
                {/* ★局域网这条路现在也有名字了(网关接上了 `serveConnection` 的 onPeer)——
                    用户 2026-09-20 原话:「只显示了连接了两个,但是是哪两台,没有显示」。
                    两条路的行长得一样,因为它们本来就是同一件事,只是进来的门不同。 */}
                {lanDevs.map((d) => (
                  <li className="hd-row" key={d.cid}>
                    <span className="hd-dot" />
                    <span className="hd-nm" title={d.label}>{d.label}</span>
                    <span className="hd-via">局域网</span>
                    <button
                      className="set-btn"
                      disabled={busy || kicking === d.cid}
                      title="断开这一台。它会自己重连 —— 卡住的连接可以用它救回来"
                      onClick={async () => {
                        // ★同中转那条:不接返回值,新状态从 onMobileStatus 那条广播回来。
                        setKicking(d.cid)
                        try { await window.forge.mobileKick?.(d.cid) }
                        finally { setKicking('') }
                      }}
                    >
                      {kicking === d.cid ? '断开中…' : '断开'}
                    </button>
                    {d.deviceId && <RemoveBtn deviceId={d.deviceId} label={d.label} onRevoke={revoke} />}
                  </li>
                ))}
                {lanPending > 0 && (
                  <li className="hd-row" key="lan-pending">
                    <span className="hd-dot" />
                    <span className="hd-nm">{lanPending} 台</span>
                    <span className="hd-via">局域网 · 正在连接</span>
                  </li>
                )}
              </ul>
            )}
          </div>
        )
      })()}

      {/* ★★「谁能连进来」和「现在连着谁」是两件事:上面是后者(能「断开」,会自己重连),
          这里是前者(能「移除」,永久)。离线的设备也在这里 —— 要撤掉一台,不必等它连上来。 */}
      {authorized.length > 0 && (
        <div className="hosts-devs">
          <div className="hd-h">
            已授权设备
            <span className="hd-n">{authorized.length}</span>
          </div>
          <ul className="hd-list">
            {authorized.map((d) => (
              <li className="hd-row" key={d.id}>
                <span className="hd-dot" style={d.online ? undefined : { background: 'var(--faint)' }} />
                <span className="hd-nm" title={d.label}>
                  {d.legacy ? '之前配对的设备(共用旧配对码)' : d.pending ? '等待配对(这枚码还没被用过)' : d.label || '未命名设备'}
                </span>
                <span className="hd-via">{d.online ? '在线' : d.lastSeenAt ? `上次 ${seenAgo(d.lastSeenAt)}` : ''}</span>
                <button className="set-btn danger" onClick={() => revoke(d)} title="令牌作废并立刻断开,对方不会自动重连">
                  {d.legacy ? '撤销' : '移除'}
                </button>
              </li>
            ))}
          </ul>
          <div className="hosts-conn-foot">
            <button
              className="set-btn danger"
              onClick={() => {
                if (!window.confirm('全部撤销?\n所有设备立刻断开、且都连不回来,要继续用的得重新配对。令牌泄露又不知道是哪台时用。')) return
                void window.forge.devicesRevokeAll().then(setAuthorized)
                setPair(null); setShowQr(false)
              }}
            >
              全部撤销
            </button>
            <span className="set-desc">「断开」只断这一次,对方会自己重连;「移除」才是永久的。</span>
          </div>
        </div>
      )}
    </>
  )
}

/** 已连接列表里那颗「移除」:和已授权列表里的是同一个动作(按这条连接用的令牌撤销)。 */
function RemoveBtn({ deviceId, label, onRevoke }: { deviceId: string; label: string; onRevoke: (d: { id: string; legacy?: boolean; label?: string }) => void }) {
  const legacy = deviceId === 'legacy'
  return (
    <button
      className="set-btn danger"
      title={legacy ? '它用的是升级前的共用配对码 —— 撤销会让所有用旧码的设备一起失效' : '令牌作废并立刻断开,对方不会自动重连'}
      onClick={() => onRevoke({ id: deviceId, legacy, label })}
    >
      {legacy ? '撤销旧码' : '移除'}
    </button>
  )
}

function seenAgo(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}
