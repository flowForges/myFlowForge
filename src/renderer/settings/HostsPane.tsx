import { useCallback, useEffect, useState } from 'react'
import { type HostInput, type HostStatusView, type RemoteHostView } from '@shared/remote/hostView'
import './hostspane.css'
import { parsePairingLink } from '@shared/remote/pairingLink'

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
export function HostsPane() {
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
          `shell/Titlebar.tsx` 正中已经挂着 `HostSwitcher`,它做的是同一件事而且做得更好:
          **一直在视野里**(不用打开设置)、点开就是切换菜单、而且**没配过远程主机的人根本看不到它**。
          设置里再摆一张,是同一件事说第二遍;更糟的是它得配三句话解释「灰的是正常的」
          「手机连进来不会让它变色」—— 那三句话本身就是这张卡不该在这儿的证据:
          它在解释一个自己制造的困惑。 */}
      {err && <p className="set-desc" style={{ color: 'var(--err)' }}>{err}</p>}

      <div className="set-group">
        <h4>已配的机器</h4>
        <p className="set-desc">
          切到哪台,就只看到哪台的会话、工作区和运行。外观、宠物、字体跟着你这台设备走,不会变。
        </p>
        <div className="hosts-list">
          {hosts.length === 0 && (
            <div className="hosts-empty">
              还没有添加任何远程主机
              <div style={{ marginTop: 10 }}>
                <button className="set-btn primary" onClick={() => { setFormErr(''); setDraft({ ...EMPTY }) }}>添加主机</button>
              </div>
            </div>
          )}
          {hosts.map((h) => (
            <div key={h.id} className={`host-row ${connectedId === h.id ? 'active' : ''}`}>
              <div className="info">
                <div className="name">
                  {h.label || '(未命名)'}
                  <span className="host-tag">{h.kind === 'ssh' ? 'SSH 隧道' : '直接连接'}</span>
                  {connectedId === h.id && <span className="host-tag">当前</span>}
                </div>
                <div className="addr">
                  {h.kind === 'ssh' ? `${h.sshTarget || '未填 SSH 目标'} · 远端端口 ${h.address || '6767'}` : (h.address || '未填地址')}
                </div>
              </div>
              <div className="acts">
                {connectedId === h.id
                  ? <button className="set-btn" disabled={busy} onClick={() => run(() => window.forge.hostsDisconnect())}>断开</button>
                  : <button className="set-btn primary" disabled={busy} onClick={() => run(() => window.forge.hostsConnect(h.id))}>连接</button>}
                <button className="set-btn" disabled={busy} onClick={() => { setFormErr(''); setDraft({ ...h }) }}>编辑</button>
                <button className="set-btn danger" disabled={busy} onClick={() => run(() => window.forge.hostsRemove(h.id))}>删除</button>
              </div>
            </div>
          ))}
        </div>
        {!draft && <div className="bot-actions"><button className="set-btn" onClick={() => { setFormErr(''); setDraft({ ...EMPTY }) }}>添加主机</button></div>}
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

            <div className="proj-field">
              <label>标识(一个表情)</label>
              <input
                value={draft.icon}
                placeholder="🖥️ / 🌩 / 🏠 …"
                maxLength={8}
                onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
              />
            </div>
            <div className="proj-field">
              <label>标题栏上显示</label>
              <select className="sce-select" value={draft.display} onChange={(e) => setDraft({ ...draft, display: e.target.value as HostInput['display'] })}>
                <option value="both">标识 + 名称</option>
                <option value="icon">只显示标识</option>
                <option value="name">只显示名称</option>
              </select>
            </div>
            <p className="set-desc full" style={{ marginTop: -6 }}>
              标题栏正中那枚就按这个显示。只显示标识时,连接状态用<b>光圈呼吸</b>表示(像主机/显示器的指示灯);
              显示名称时用前面那个圆点。挂一串主机名在正中太抢眼,一个你自己认得的表情通常就够了。
            </p>

            <div className="proj-field full">
              <label>连接方式</label>
              <select className="sce-select" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'ssh' | 'direct', address: e.target.value === 'ssh' ? '6767' : '' })}>
                <option value="ssh">通过 SSH 连接(推荐)</option>
                <option value="direct">直接连接(局域网 / Tailscale / 本机自测)</option>
              </select>
            </div>
            <p className="set-desc full" style={{ marginTop: -6 }}>
              {draft.kind === 'ssh'
                ? '那台机器上的 daemon 只绑回环(公网上不存在那个端口),所以走 SSH 隧道过去。下面填的是 SSH 登录目标,不是网址。'
                : '直接填一个能连到的地址。局域网、Tailscale,以及「在这台电脑上自己跑一个 daemon 试试」都走这条。'}
            </p>

            {draft.kind === 'ssh' ? (
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
                  隧道由 app 自己拉起来,用的就是你平时 ssh 登这台服务器的凭据 —— 没有新密码要记。
                  <b>前提是能免密登录(密钥认证)</b>:这里没有终端可以输入密码。
                  另外要先在那台机器上把 daemon 跑起来,让它监听上面填的那个端口。
                </p>
              </>
            ) : (
              <>
                <div className="proj-field">
                  <label>地址</label>
                  <input value={draft.address} placeholder="ws://192.168.1.20:6767" onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
                </div>
                <div className="proj-field">
                  <label>访问令牌</label>
                  <input type="password" value={draft.token} placeholder="daemon pair 里那串" onChange={(e) => setDraft({ ...draft, token: e.target.value })} />
                </div>
                <p className="set-desc full">
                  daemon 绑到非回环地址时<b>必须</b>要令牌 —— 那个端口能起 agent、答权限门、开终端,
                  等于整台机器的控制权。绑回环(比如本机自测)则不需要,令牌留空即可。
                </p>
                <p className="set-desc full">
                  本机自测:<code className="hosts-cmd">node out/main/daemon.js --listen 127.0.0.1:6789</code>
                  ,然后这里填 <code className="hosts-cmd">ws://127.0.0.1:6789</code>。
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
                setDraft(null)
              })
            }}>保存</button>
            <button className="set-btn" disabled={busy} onClick={() => { setFormErr(''); setDraft(null) }}>取消</button>
          </div>
        </div>
      )}

      <div className="set-group">
        <h4>在设备之间搬清单</h4>
        <p className="set-desc">
          主机清单只存在这台设备上(它带着凭据,不该让服务器代为同步)。换台电脑或加手机时,从这里导出再导入。
        </p>
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
            <p className="set-desc">导出「含令牌」的那份等于把机器钥匙一起带走 —— 别贴进聊天记录或截图。</p>
          </>
        )}
      </div>
    </div>
  )
}
