/**
 * 「电脑上出一个二维码,手机扫一下就填好了」的那串东西。
 *
 * ★这是**同一份文件**被两边 import 的:Electron 的设置面板拿它 build,手机端拿它 parse。
 *  它不像协议那样有帧号可以对齐,一旦两边各写一份,漂移的表现是「扫了没反应」——
 *  最难查的一类,因为相机那一侧根本不会告诉你它解出了什么。
 *
 * 形如:
 *   myflowforge://add-host?v=1&a=192.168.1.20%3A6789&t=<令牌>&n=<机器名>
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
}

export type PairingParse = { ok: true; value: PairingPayload } | { ok: false; error: string }

/** 名字只是给人认的。★不限长的话,中文机器名 percent 编码后一个字 9 个字符,二维码会白白密一大截。 */
const MAX_LABEL = 24

export function buildPairingLink(p: PairingPayload): string {
  const q = [
    'v=1',
    `a=${encodeURIComponent(p.address.trim())}`,
    p.token ? `t=${encodeURIComponent(p.token)}` : '',
    p.label.trim() ? `n=${encodeURIComponent(p.label.trim().slice(0, MAX_LABEL))}` : '',
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
  // ★版本号只用来给出**看得懂的**错，不用来拒绝:新版电脑端配旧版手机端时,
  //   「请升级手机 app」远比「地址看不懂」有用。
  const v = q.get('v') ?? '1'
  if (v !== '1') return { ok: false, error: `这个码是新版电脑端生成的(v${v}),升级一下手机 app` }

  return { ok: true, value: { address, token: (q.get('t') ?? '').trim(), label: (q.get('n') ?? '').trim() } }
}
