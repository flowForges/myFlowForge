import { useCallback, useEffect, useState } from 'react'
import { type HostDisplay, type HostInput, type HostStatusView, type RemoteHostView } from '@shared/remote/hostView'
import './hostspane.css'
import { parsePairingLink } from '@shared/remote/pairingLink'
import { HOST_ICONS, currentHostIcon } from '@shared/hostIcons'
import { Select } from './Select'

const EMPTY: HostInput = { label: '', kind: 'ssh', address: '6767', sshTarget: '', icon: '', display: 'both', token: '', pubKey: '', relay: '' }

/**
 * 远程主机 —— **这台电脑连出去**。
 *
 * ★★2026-09-02:手机那一整节(让手机连进来 / 二维码 / 中转)**搬到了 `PhonePane`**。
 *  用户原话:「一部分是本机 daemon 启动让手机来连,还有一部分是本机去连别的 daemon,
 *  这部分要分开,不然看起来很乱」。对的,而且不只是「加个隔断」的事:
 *  这两件事**除了「主机」这个词之外毫无关系** —— 不共用数据、不共用状态、不共用代码路径
 *  (一个是 `daemon/config` + `relayController`,一个是 `hostStore`)。
 *  原来那句「两者共用同一套概念(地址/令牌/谁连着谁)」的注释是不成立的。
 *  ★而且设置面板的惯例本来就是**一个话题一页**(23 个分页里连「Hook 库」「Skill」都各占一页),
 *   「主机」是唯一一个扛着两个不相干话题的页。
 */
/**
 * 保存前的校验。★**返回一句话,而不是把按钮置灰。**
 *
 * 第一版是「名称为空就 disabled」——用户填完地址点保存,按钮毫无反应也没有任何解释,
 * 看起来就是按钮坏了。真机验收时正是卡在这一步:主机一台都没存进去,后面全部步骤都白做,
 * 而现象却是「没有状态条」,完全指不到原因。
 */
function validate(d: HostInput): string {
  if (!d.label.trim()) return '给这台主机起个名字(随便什么,你自己认得就行)'
  if (d.kind === 'ssh') {
    const t = d.sshTarget.trim()
    if (!t) return 'SSH 目标不能为空,形如 用户名@1.2.3.4'
    // ★真机验收就栽在这儿:把 ws://127.0.0.1 填进了 SSH 目标,ssh 真的去连了一台叫
    //   「ws://127.0.0.1」的机器。只查非空是不够的 —— 这个值一眼就能看出填错了框。
    if (/:\/\//.test(t)) return 'SSH 目标不要写 ws:// —— 那是「直接连接」用的。把上面的连接方式改成「直接连接」,或者这里填 用户名@1.2.3.4'
    if (t.includes('/')) return 'SSH 目标里不该有斜杠,形如 用户名@1.2.3.4'
    if (!d.address.trim()) return '远端 daemon 端口不能为空,默认是 6767'
    if (!/^\d+$/.test(d.address.trim())) return '远端 daemon 端口只填数字(daemon 在它自己机器上监听的那个端口)'
    return ''
  }
  const a = d.address.trim()
  if (!a) return '地址不能为空,形如 ws://192.168.1.20:6767'
  if (a.includes('@')) return '这看起来是 SSH 目标 —— 把上面的连接方式改成「通过 SSH 连接」,或者这里填 ws://主机:端口'
  try {
    const u = new URL(normalizeAddress(a))
    if (!u.hostname) return '地址里没有主机名,形如 ws://192.168.1.20:6767'
  } catch { return '地址看不懂,形如 ws://192.168.1.20:6767' }
  return ''
}

/** 直连地址容错:很多人会直接写 `127.0.0.1:6789`,不带 scheme 的话 WebSocket 会当场抛。 */
export function normalizeAddress(a: string): string {
  const v = a.trim()
  if (!v || /^wss?:\/\//i.test(v)) return v
  return `ws://${v}`
}

/**
 * 多主机(第二期 B)。
 *
 * 两条硬约束来自设计文档:
 * ① **断线态必须显式** —— 不能拿缓存假装在线。所以顶上那张状态卡永远说实话,
 *    包括「已断开,N 秒后重连」这种中间态。
 * ② 默认推荐 **SSH 隧道**:daemon 只绑回环,公网上不存在那个端口。直接填地址那条留给
 *    局域网 / Tailscale,并且必须配访问令牌。
 */
export function HostsPane({ hostChip, onHostChipChange }: {
  /** 底部栏那枚主机按钮的显示方式。★**一份、全局** —— 见下面那个 set-group 里的注释。 */
  hostChip: HostDisplay
  onHostChipChange: (v: HostDisplay) => void
}) {
  const [hosts, setHosts] = useState<RemoteHostView[]>([])
  const [status, setStatus] = useState<HostStatusView | null>(null)
  const [draft, setDraft] = useState<HostInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [formErr, setFormErr] = useState('')
  /** 粘贴配对码那个框,和它下面那句反馈。★只在表单里活着,不进 draft。 */
  const [pairText, setPairText] = useState('')
  const [pairMsg, setPairMsg] = useState('')
  const [ioText, setIoText] = useState('')
  const [ioOpen, setIoOpen] = useState(false)

  /**
   * ★★开表单和关表单**只走这一个入口**。原来是四处各写一遍 `setFormErr(''); setDraft(...)`,
   *  而 `pairText` 谁都没清 ⇒ 存完一台之后再点「添加主机」,那个框里还是上一台的配对码;
   *  照着它再点一次「填进表单 → 保存」就又存了同一台机器一遍(用户报的「点击保存,又会存一条」)。
   */
  const openDraft = useCallback((d: HostInput | null) => {
    setFormErr('')
    setPairText('')
    setPairMsg('')
    setDraft(d)
  }, [])

  const reload = useCallback(async () => {
    setHosts(await window.forge.hostsList())
    setStatus(await window.forge.hostsStatus())
  }, [])

  useEffect(() => {
    // 同 RemoteBar:先订阅再拉快照,晚到的快照丢掉。否则刚点完「连接」,
    // 一个更旧的快照会把「已连接」盖回「未连接」。
    let pushed = false
    const off = window.forge.onHostStatus((s) => { pushed = true; setStatus(s) })
    void window.forge.hostsList().then(setHosts)
    void window.forge.hostsStatus().then((s) => { if (!pushed) setStatus(s) })
    return off
  }, [])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('')
    try { await fn() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false); await reload() }
  }

  const connectedId = status?.hostId ?? null

  return (
    <div className="hosts-pane">
      {/* ★★2026-09-02:这里原来有一张「你在哪台机器上干活」的状态卡(本机 / 灰点 / 回到本机),
          **已删**。用户原话:「特别是顶部的本机,这个有展示的必要么?」——没有。
          `shell/StatusBar.tsx` 上已经挂着 `HostSwitcher`(2026-09-04 从标题栏搬到了底部状态栏),
          它做的是同一件事而且做得更好:
          **一直在视野里**(不用打开设置)、点开就是切换菜单、而且**没配过远程主机的人根本看不到它**。
          设置里再摆一张,是同一件事说第二遍;更糟的是它得配三句话解释「灰的是正常的」
          「手机连进来不会让它变色」—— 那三句话本身就是这张卡不该在这儿的证据:
          它在解释一个自己制造的困惑。 */}
      {err && <p className="set-desc" style={{ color: 'var(--err)' }}>{err}</p>}

      <div className="set-group">
        <h4>已配的机器</h4>
        <p className="set-desc">切到哪台,就只看到哪台的会话和工作区。</p>
        <div className="hosts-list">
          {hosts.length === 0 && (
            <div className="hosts-empty">
              还没有添加任何远程主机
              <div style={{ marginTop: 10 }}>
                <button className="set-btn primary" onClick={() => openDraft({ ...EMPTY })}>添加主机</button>
              </div>
            </div>
          )}
          {hosts.map((h) => (
            <div key={h.id} className={`host-row ${connectedId === h.id ? 'active' : ''}`}>
              {/* ★图标在这一行里是**认人**用的,和底部那枚按钮、切换菜单里是同一枚
                  (三处都走 `currentHostIcon`)。原来这张列表是唯一不画它的地方 ——
                  于是「我给它选的图标到底存进去没有」在设置页里根本看不出来。 */}
              <div className="host-ico" aria-hidden="true">{currentHostIcon(h.icon)}</div>
              <div className="info">
                <div className="name">
                  {h.label || '(未命名)'}
                  {/* ★★中转必须排在最前面判。原来这儿只有 ssh / direct 两种,于是**一台走中转的
                      主机被标成「直接连接」** —— 用户当场问的「它这种是不是没走中转?我那边好像
                      还是本地」就是这么来的:配对码里明明带了中转地址,界面上却一个字都不提。
                      连接方式是**看不见**的属性,界面不说就没有第二个地方能说。 */}
                  <span className="host-tag">{h.relay ? '经中转' : h.kind === 'ssh' ? 'SSH 隧道' : '直接连接'}</span>
                  {connectedId === h.id && <span className="host-tag">当前</span>}
                </div>
                <div className="addr">
                  {h.relay
                    // 走中转时**拨的是中转**,`address` 只是「这台机器以后出现在局域网里时的地址」
                    // 的一份记录 —— 把它当成连接目标显示出来,就是在说一件不成立的事。
                    ? h.relay
                    : h.kind === 'ssh' ? `${h.sshTarget || '未填 SSH 目标'} · 远端端口 ${h.address || '6767'}` : (h.address || '未填地址')}
                </div>
              </div>
              <div className="acts">
                {connectedId === h.id
                  ? <button className="set-btn" disabled={busy} onClick={() => run(() => window.forge.hostsDisconnect())}>断开</button>
                  : <button className="set-btn primary" disabled={busy} onClick={() => run(() => window.forge.hostsConnect(h.id))}>连接</button>}
                <button className="set-btn" disabled={busy} onClick={() => openDraft({ ...h })}>编辑</button>
                <button className="set-btn danger" disabled={busy} onClick={() => run(() => window.forge.hostsRemove(h.id))}>删除</button>
              </div>
            </div>
          ))}
        </div>
        {!draft && <div className="bot-actions"><button className="set-btn" onClick={() => openDraft({ ...EMPTY })}>添加主机</button></div>}
      </div>

      {draft && (
        <div className="set-group">
          <h4>{draft.id ? '编辑主机' : '添加主机'}</h4>
          {/* ★★2026-09-02:粘贴配对码 —— **走中转连另一台电脑唯一的入口**。
              手机是扫码,电脑之间没法扫,所以那台机器的「手机」页里同一枚码多了一颗「复制配对码」。
              ★为什么不给公钥/中转地址各摆一个手填框:公钥是 44 个字符的 base64,**没人核对得了**,
               错一个字符只会静默连不上;中转地址错了则会拨到一个没人应答的地方然后一直转。
               这两样只从码里来 —— 和手机端 `add-host.tsx` 是同一条规矩(那边它们也只读、不给改)。
              ★★解析用的是 `@shared/remote/pairingLink`,**和生成那枚码的是同一份文件**
               (两边 import 同一个模块)。各写一份的话,漂移的表现是「粘了没反应」—— 最难查的一类。 */}
          <div className="proj-field full" style={{ marginBottom: 10 }}>
            <label>粘贴配对码(可选)</label>
            <div className="hosts-inline">
              <input
                value={pairText}
                placeholder="myflowforge://add-host?…  在那台电脑的「设置 → 手机」里复制"
                onChange={(e) => { setPairText(e.target.value); setPairMsg('') }}
              />
              <button
                className="set-btn"
                onClick={() => {
                  const r = parsePairingLink(pairText)
                  if (!r.ok) { setPairMsg(r.error); return }
                  const v = r.value
                  // ★地址原样进 `address`:走中转时它只是个记录(拨的是中转),但以后那台机器
                  //  真在局域网里出现时,这个地址正好是对的 —— 和手机端同一条。
                  // ★公钥原样存:直连那条路也走端到端加密(`gateway.ts` 的首帧嗅探握手)。
                  setDraft({
                    ...draft,
                    label: draft.label || v.label || v.address,
                    kind: 'direct',
                    address: v.address.startsWith('ws') ? v.address : `ws://${v.address}`,
                    token: v.token,
                    pubKey: v.pubKey ?? '',
                    relay: v.relay ?? '',
                  })
                  setPairMsg(
                    v.relay
                      ? '已填好 —— 这台走中转,端到端加密'
                      : v.pubKey
                        ? '已填好 —— 直连,端到端加密'
                        : '已填好 —— 直连(不加密)',
                  )
                }}
              >
                填进表单
              </button>
            </div>
          </div>
          {pairMsg && <p className="set-desc full" style={{ marginTop: -4 }}>{pairMsg}</p>}
          {/* ★把「这条连接是什么性质」摆出来:加密和中转都是**看不见**的属性,
              不说的话人无从知道自己配出来的是明文还是密文。 */}
          {(draft.pubKey || draft.relay) && (
            <p className="set-desc full" style={{ marginTop: -4 }}>
              {draft.relay ? <>这台走<b>中转</b>({draft.relay}),</> : null}
              {draft.pubKey ? <>已带身份公钥 —— <b>端到端加密</b>,中转读不到内容。</> : null}
            </p>
          )}
          <div className="hosts-form">
            <div className="proj-field full">
              <label>名称</label>
              <input value={draft.label} placeholder="云服务器" onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </div>

            {/* ★★原来这是个**手打表情**的输入框。用户原话「图标不能下拉选择么」——
                他是对的:手打一个表情在 mac 上意味着按 ⌃⌘空格 翻表情面板,为一件纯装饰的事
                付这个代价太荒谬。★候选名单和手机端**是同一份**(`@shared/hostIcons`),
                不是这儿又抄一份:同一台主机在两块屏上长得不一样,没人会当 bug 报,
                只会觉得这个 app 做得糙。 */}
            <div className="proj-field">
              <label>图标</label>
              <div className="set-icons" role="radiogroup" aria-label="主机图标">
                {HOST_ICONS.map((o) => {
                  const on = currentHostIcon(draft.icon) === o.icon
                  return (
                    <button
                      type="button"
                      key={o.icon}
                      role="radio"
                      aria-checked={on}
                      aria-label={o.label}
                      title={o.label}
                      className={`set-icon${on ? ' on' : ''}`}
                      onClick={() => setDraft({ ...draft, icon: o.icon })}
                    >
                      {o.icon}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* ★★中转**不是**这个下拉框里的一项,它跟着配对码一起来 —— 而这件事必须
                **在框里说出来**。用户原话:「连接方式 哪有中转啊?」
                他去那儿找是完全对的:到达一台主机就是三条路(SSH 隧道 / 直连 / 中转),
                而这个框自称「连接方式」却只列两条。
                ★★更糟的是原来那版:粘完带中转的配对码之后,`kind` 被设成 `direct`,
                于是这个框**显示「直接连接」** —— 和列表里那枚标签犯的是同一个错
                (说了一件不成立的事),只是我上一轮只修了列表那一层。
                ★为什么不给中转做成可选的一项:选了它就得手填中转地址**和身份公钥**,
                而公钥是 44 个字符的 base64,没人核对得了,错一个字符只会静默连不上。
                这两样只能从码里来 —— 和手机端 `add-host.tsx` 同一条规矩。 */}
            {draft.relay ? (
              <div className="proj-field full">
                <label>连接方式</label>
                <div className="host-locked">
                  <span className="host-locked-v">经中转 · {draft.relay}</span>
                  <button
                    className="set-btn"
                    onClick={() => setDraft({ ...draft, relay: '' })}
                    title="清掉中转地址,改回直连或 SSH"
                  >
                    改用直连
                  </button>
                </div>
              </div>
            ) : (
              <div className="proj-field full">
                <label>连接方式</label>
                <Select
                  ariaLabel="连接方式"
                  value={draft.kind}
                  onChange={(v) => setDraft({ ...draft, kind: v, address: v === 'ssh' ? '6767' : '' })}
                  options={[
                    { value: 'ssh', label: '通过 SSH 连接(推荐)' },
                    { value: 'direct', label: '直接连接(局域网 / Tailscale / 本机自测)' },
                  ]}
                />
              </div>
            )}
            <p className="set-desc full" style={{ marginTop: -6 }}>
              {draft.relay
                ? '两边各在各的网时走这条。端到端加密,中转读不到内容。'
                : draft.kind === 'ssh'
                  ? '下面填 SSH 登录目标,不是网址。'
                  : '局域网、Tailscale、本机自测走这条。'}
            </p>
            {/* ★这句话摆在**没有中转的时候** —— 它回答的正是「我要连一台不在同一个网里的机器,
                该选哪一项?」而答案是「哪一项都不选,去粘那枚码」。不说的话,人只会在
                两个选项之间来回猜。 */}
            {!draft.relay && (
              <p className="set-desc full" style={{ marginTop: -8 }}>
                <b>不在同一个网络</b>?这两项都不对 —— 去上面粘配对码。
              </p>
            )}

            {!draft.relay && draft.kind === 'ssh' ? (
              <>
                <div className="proj-field">
                  <label>SSH 目标</label>
                  <input value={draft.sshTarget} placeholder="用户名@1.2.3.4" onChange={(e) => setDraft({ ...draft, sshTarget: e.target.value })} />
                </div>
                <div className="proj-field">
                  <label>远端 daemon 端口</label>
                  <input value={draft.address} placeholder="6767" onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
                </div>
                <p className="set-desc full">
                  用你平时 ssh 登它的凭据,<b>前提是免密(密钥认证)</b>。那台机器上要先跑起 daemon。
                </p>
              </>
            ) : (
              <>
                <div className="proj-field">
                  {/* ★走中转时这个地址**不是连接目标**(拨的是中转),它只是「这台机器以后出现在
                      局域网里时的地址」的一份记录。标签跟着改,不然人会盯着它问「为什么连的是
                      127.0.0.1」—— 那正是这一轮的起点。 */}
                  <label>{draft.relay ? '局域网地址(备用,现在不走它)' : '地址'}</label>
                  <input value={draft.address} placeholder="ws://192.168.1.20:6767" onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
                </div>
                <div className="proj-field">
                  <label>访问令牌</label>
                  <input type="password" value={draft.token} placeholder="daemon pair 里那串" onChange={(e) => setDraft({ ...draft, token: e.target.value })} />
                </div>
                <p className="set-desc full">
                  daemon 绑非回环地址时<b>必须</b>要令牌 —— 那个端口等于整台机器的控制权。绑回环可留空。
                </p>
              </>
            )}
          </div>
          {formErr && <p className="hosts-formerr">{formErr}</p>}
          <div className="bot-actions">
            <button className="set-btn primary" disabled={busy} onClick={() => {
              // ★提示必须显示在**按钮旁边**。第一版把它写进面板顶部那个 err —— 用户滚到表单
              //   这儿点保存,提示出现在视野之外,看到的现象就是「点了没反应」。
              const bad = validate(draft)
              if (bad) { setFormErr(bad); return }
              setFormErr('')
              void run(async () => {
                await window.forge.hostsUpsert({ ...draft, address: draft.kind === 'direct' ? normalizeAddress(draft.address) : draft.address.trim() })
                openDraft(null)
              })
            }}>保存</button>
            <button className="set-btn" disabled={busy} onClick={() => openDraft(null)}>取消</button>
          </div>
        </div>
      )}

      {/* ── 高级 ────────────────────────────────────────────────────────────
          ★★和「手机」那一屏同一副骨架:主流程 → 一个默认收起的「高级」。原来这一屏没有折叠,
           于是「配一次就再也不碰」的两件事(按钮长什么样、搬清单)一直挡在正常人的路上,
           顶上那段还花 78 个字去解释**另一个界面元素**(底部按钮上那颗圆点是什么颜色)——
           设置页不该给别处的控件写说明书,那枚按钮自己有 tooltip。
          ★`<details>` 而不是自己写折叠:键盘可达和「默认收起」都由浏览器保证。 */}
      <details className="hosts-adv">
        <summary>高级 —— 按钮显示方式、在设备之间搬清单</summary>

        {/* ★★这是**那枚按钮**的设置,不是某一台主机的设置。旧版把它放在每台主机的编辑表单里,
            后果有两个,都是用户当场撞上的:① 同一枚按钮切一台主机就换一副长相;
            ② 本机没有那张表单,于是它被写死成「只显示名称」——「我设置了只显示图标,
            但是本机还是显示一个大按钮」。所以它归到这儿:一份、全局、本机也照办。 */}
        <div className="proj-field">
          <label>底部那枚主机按钮</label>
          <Select
            ariaLabel="主机按钮显示"
            value={hostChip}
            onChange={onHostChipChange}
            options={[
              { value: 'both', label: '图标 + 名称' },
              { value: 'icon', label: '只显示图标' },
              { value: 'name', label: '只显示名称' },
            ]}
          />
        </div>
        <p className="set-desc">一份、全局,本机也照办。</p>

        <div className="hosts-adv-sep" />

        <p className="set-desc">清单只存在这台设备上。换机器时导出再导入。</p>
        {!ioOpen && <div className="hosts-io">
          <button className="set-btn" onClick={async () => { setIoText(await window.forge.hostsExport(false)); setIoOpen(true) }}>导出(不含令牌)</button>
          <button className="set-btn" onClick={async () => { setIoText(await window.forge.hostsExport(true)); setIoOpen(true) }}>导出(含令牌)</button>
          <button className="set-btn" onClick={() => { setIoText(''); setIoOpen(true) }}>导入</button>
        </div>}
        {ioOpen && (
          <>
            <textarea value={ioText} onChange={(e) => setIoText(e.target.value)} placeholder="把导出的内容粘到这里" />
            <div className="hosts-io" style={{ marginTop: 8 }}>
              <button className="set-btn primary" disabled={busy || !ioText.trim()} onClick={() => run(async () => {
                const r = await window.forge.hostsImport(ioText)
                if (!r.ok) throw new Error(r.error)
                setIoOpen(false); setIoText('')
              })}>导入这段</button>
              <button className="set-btn" onClick={() => { setIoOpen(false); setIoText('') }}>关闭</button>
            </div>
            {/* ★这句不许压掉:「含令牌」那份等于机器钥匙,是这一屏唯一一条安全提示。 */}
            <p className="set-desc">「含令牌」那份等于机器钥匙 —— 别贴进聊天记录或截图。</p>
          </>
        )}
      </details>
    </div>
  )
}
