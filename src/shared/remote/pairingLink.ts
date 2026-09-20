/**
 * 「电脑上出一个二维码,手机扫一下就填好了」的那串东西。
 *
 * ★这是**同一份文件**被两边 import 的:Electron 的设置面板拿它 build,手机端拿它 parse。
 *  它不像协议那样有帧号可以对齐,一旦两边各写一份,漂移的表现是「扫了没反应」——
 *  最难查的一类,因为相机那一侧根本不会告诉你它解出了什么。
 *
 * 形如:
 *   myflowforge://add-host?v=1&a=192.168.1.20%3A6789&t=<令牌>&n=<机器名>&k=<公钥>&r=<中转地址>
 *
 * ★★`k`(daemon 长期公钥)和 `r`(中转地址)是第三期加的,**两个都可以没有**:
 *  · 都没有 = 局域网直连、不加密。那条链路上没有第三方,而且老版电脑端出的码就是这个样子 ——
 *    **必须继续能扫**,否则一次升级会让所有配过对的手机同时失效。
 *  · 只有 `k` = 直连,但走端到端加密。有公网 IP / Tailscale / frp 的人走这条。
 *  · `k` + `r` = 走中转。★没有 `k` 的 `r` 是**无效的**:中转是不可信的哑管道,
 *    不验证对面身份就把令牌和全部内容交给它,是个真实的安全倒退,所以那种组合当错误拒掉。
 *
 * ★`add-host` 就是手机端 expo-router 的路由名,不是随手起的 —— 深链直接落在那一屏,
 *  参数名 `a/t/n` 也就是那一屏 `useLocalSearchParams()` 读到的键。改名要两边一起改。
 *
 * ★**不用 `new URL()`**。RN 的 URL 实现对非 http(s) 的 scheme 会返回空 hostname
 *  (`wsUrl.ts` 已经为这件事栽过一次),自定义 scheme 只会更糟。这里全部手写解析。
 */

export const PAIRING_SCHEME = 'myflowforge'
export const PAIRING_ROUTE = 'add-host'

export type PairingPayload = {
  /** `主机:端口`,不带 scheme —— 手机那一屏本来就接受这种写法并自己补 ws:// */
  address: string
  /** 访问令牌;绑回环时为空 */
  token: string
  /** 一个给人看的名字(通常是机器名),可以为空 */
  label: string
  /**
   * daemon 长期公钥的 base64(32 字节)。**整条链路唯一的信任锚点** ——
   * 它由人从电脑屏幕搬到手机上,是唯一不经过网络的一步。
   * 没有它 = 老版本的码 = 直连不加密。
   */
  pubKey?: string
  /** 中转地址(`ws://` / `wss://`)。有它就走中转,没有就直连。★它单独出现无效,必须配 `pubKey`。 */
  relay?: string
}

export type PairingParse = { ok: true; value: PairingPayload } | { ok: false; error: string }

/** 名字只是给人认的。★不限长的话,中文机器名 percent 编码后一个字 9 个字符,二维码会白白密一大截。 */
const MAX_LABEL = 24
/** Ed25519 公钥是 32 字节 → base64 44 个字符(含一个 `=`)。★长度不对就不是一把公钥。 */
const PUBKEY_B64_LEN = 44
/** 中转地址上限。★二维码的容量是有限的,而一个几百字符的"地址"本来也不是地址。 */
const MAX_RELAY = 128

export function buildPairingLink(p: PairingPayload): string {
  const q = [
    // ★版本号仍然是 1。`k`/`r` 是**可选新增字段**,老手机遇到它们会照旧忽略,
    //  照样能按 a/t/n 连上 —— 这正是不该升版本号的情况。升了的话老手机会直接拒扫。
    'v=1',
    `a=${encodeURIComponent(p.address.trim())}`,
    p.token ? `t=${encodeURIComponent(p.token)}` : '',
    p.label.trim() ? `n=${encodeURIComponent(p.label.trim().slice(0, MAX_LABEL))}` : '',
    p.pubKey ? `k=${encodeURIComponent(p.pubKey)}` : '',
    p.relay ? `r=${encodeURIComponent(p.relay.trim())}` : '',
  ].filter(Boolean)
  return `${PAIRING_SCHEME}://${PAIRING_ROUTE}?${q.join('&')}`
}

export function parsePairingLink(raw: string): PairingParse {
  const s = raw.trim()
  if (!s) return { ok: false, error: '没扫到内容' }

  // scheme 大小写不敏感;`://` 和 `:/` 都收(不同相机 app 回吐的形状不一样)。
  const m = /^([a-z][a-z0-9+.-]*):\/{0,2}([^?#]*)(?:\?([^#]*))?/i.exec(s)
  if (!m) return { ok: false, error: '这不是一个链接' }
  if (m[1].toLowerCase() !== PAIRING_SCHEME) {
    return { ok: false, error: `这个码不是 myFlowForge 的(它是 ${m[1].toLowerCase()}: 开头的)` }
  }
  // 路径可能带首尾斜杠:`myflowforge://add-host/`
  const route = m[2].replace(/^\/+|\/+$/g, '').toLowerCase()
  if (route !== PAIRING_ROUTE) return { ok: false, error: '这是 myFlowForge 的码,但不是「添加主机」用的那个' }

  const q = new Map<string, string>()
  for (const part of (m[3] ?? '').split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    const k = i < 0 ? part : part.slice(0, i)
    const v = i < 0 ? '' : part.slice(i + 1)
    // `+` 在 query 里是空格。中文机器名不会碰到,但别人手搓的码可能会。
    try { q.set(k, decodeURIComponent(v.replace(/\+/g, ' '))) } catch { q.set(k, v) }
  }

  const address = (q.get('a') ?? '').trim()
  if (!address) return { ok: false, error: '这个码里没有地址' }

  const pubKey = (q.get('k') ?? '').trim()
  // ★长度不对就整条拒。这是信任锚点 —— 「大概能解出来」在这里等于「接受了一把来路不明的公钥」。
  //  照单全收的话,握手会在后面某处静默失败,而用户看到的是「转圈」,完全无从查起。
  if (pubKey && (pubKey.length !== PUBKEY_B64_LEN || !/^[A-Za-z0-9+/]+={0,2}$/.test(pubKey))) {
    return { ok: false, error: '这个码里的身份公钥不完整,请在电脑上重新生成一次' }
  }
  const relay = (q.get('r') ?? '').trim()
  if (relay) {
    if (relay.length > MAX_RELAY) return { ok: false, error: '这个码里的中转地址太长了' }
    if (!/^wss?:\/\//i.test(relay)) return { ok: false, error: '中转地址要以 ws:// 或 wss:// 开头' }
    // ★★没有公钥的中转地址一律拒。中转是**不可信**的哑管道:不验证对面身份就把令牌和
    //  全部对话内容交给它,不是"先跑通再加固",是一个真实的安全倒退。宁可扫不上。
    if (!pubKey) return { ok: false, error: '这个码要走中转,但没带身份公钥 —— 请在电脑上重新生成' }
  }
  // ★版本号只用来给出**看得懂的**错，不用来拒绝:新版电脑端配旧版手机端时,
  //   「请升级手机 app」远比「地址看不懂」有用。
  const v = q.get('v') ?? '1'
  if (v !== '1') return { ok: false, error: `这个码是新版电脑端生成的(v${v}),升级一下手机 app` }

  return {
    ok: true,
    value: {
      address,
      token: (q.get('t') ?? '').trim(),
      label: (q.get('n') ?? '').trim(),
      // 空串一律回落成 undefined —— 下游只需要判「有没有」,不用再各写一遍 `x && x !== ''`。
      pubKey: pubKey || undefined,
      relay: relay || undefined,
    },
  }
}
