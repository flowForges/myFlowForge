import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * 手机上记住的主机。
 *
 * ★与桌面端的 `RemoteHostView` 有意**不是同一个类型**:桌面端还带 SSH 隧道那一路
 * (`kind: 'ssh'` + `sshTarget`),而手机端开不了 ssh 子进程 —— 把那两个字段摆在表单上,
 * 只会重演「用户把 ws:// 填进 SSH 目标框」那一幕。手机端只有一种连法:直连 WebSocket。
 */
export type MobileHost = {
  id: string
  label: string
  /** 完整 ws:// 或 wss:// 地址 */
  url: string
  /** 绑回环的 daemon 不要令牌;局域网监听的强制要 */
  token: string
  /** 一个 emoji,空=用默认 */
  icon: string
  lastConnectedAt: number
}

export const DEFAULT_HOST_ICON = '🖥️'

const HOSTS_KEY = 'mff.hosts.v1'
const ACTIVE_KEY = 'mff.activeHost.v1'

export type ParsedAddress = { ok: true; url: string } | { ok: false; error: string }

/**
 * 把用户填的地址正规化成一个 ws URL。
 *
 * ★**只查非空是不够的**。桌面端上一轮真机点验就栽在这:用户把 `ws://127.0.0.1:6789` 填进了
 * 「SSH 目标」框,那一栏当然非空,于是 ssh 真的去连一台叫 `ws://127.0.0.1` 的机器。
 * 校验必须**看内容**:协议对不对、有没有主机名、端口是不是数字。
 */
export function parseAddress(raw: string): ParsedAddress {
  const s = raw.trim()
  if (!s) return { ok: false, error: '填一个地址,比如 192.168.1.10:6789' }
  if (/^https?:\/\//i.test(s)) return { ok: false, error: '这是网页地址。要 ws:// 开头(或者只填 主机:端口)' }
  // 只填了 host:port 是最常见的输入,补上 ws:// 而不是报错。
  const withScheme = /^wss?:\/\//i.test(s) ? s : `ws://${s}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return { ok: false, error: '地址看不懂,应该长这样:192.168.1.10:6789' }
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return { ok: false, error: '只支持 ws:// 或 wss://' }
  if (!u.hostname) return { ok: false, error: '缺主机名或 IP' }
  if (!u.port) return { ok: false, error: '缺端口 —— daemon 默认监听 6789' }
  if (!/^\d+$/.test(u.port) || +u.port < 1 || +u.port > 65535) return { ok: false, error: `端口 ${u.port} 不是有效端口` }
  return { ok: true, url: `${u.protocol}//${u.host}` }
}

/** 严格四段 IPv4 的回环判定。`startsWith('127.')` 会把 `127.0.0.1.evil.com` 判成回环。 */
export function isLoopbackUrl(url: string): boolean {
  let h: string
  try {
    h = new URL(url).hostname
  } catch {
    return false
  }
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  return m.slice(1).every((n) => +n <= 255) && m[1] === '127'
}

export async function loadHosts(): Promise<MobileHost[]> {
  try {
    const raw = await AsyncStorage.getItem(HOSTS_KEY)
    if (!raw) return []
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    // 存下来的东西是过去某个版本写的,字段可能缺。逐个字段兜底,别整份丢掉 ——
    // 丢整份等于用户配的主机凭空消失,而他不会知道为什么。
    return v
      .filter((h) => h && typeof h.id === 'string' && typeof h.url === 'string')
      .map((h): MobileHost => ({
        id: h.id,
        label: typeof h.label === 'string' && h.label ? h.label : h.url,
        url: h.url,
        token: typeof h.token === 'string' ? h.token : '',
        icon: typeof h.icon === 'string' ? h.icon : '',
        lastConnectedAt: typeof h.lastConnectedAt === 'number' ? h.lastConnectedAt : 0,
      }))
  } catch {
    return []
  }
}

export async function saveHosts(hosts: MobileHost[]): Promise<void> {
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(hosts))
}

export async function loadActiveHostId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

export async function saveActiveHostId(id: string | null): Promise<void> {
  if (id) await AsyncStorage.setItem(ACTIVE_KEY, id)
  else await AsyncStorage.removeItem(ACTIVE_KEY)
}

let seq = 0
export function newHostId(): string {
  seq += 1
  return `h${Date.now().toString(36)}${seq.toString(36)}`
}
