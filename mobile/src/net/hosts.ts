import AsyncStorage from '@react-native-async-storage/async-storage'
import { isLoopbackHost, parseWsUrl } from './wsUrl'

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
  /**
   * daemon 的长期公钥(base64,来自配对码里的 `k`)。**有它就走端到端加密。**
   * ★可选:老配对码没有它,那些主机继续按明文直连工作 —— 一次升级不该让已经配好的主机失效。
   */
  pubKey?: string
  /**
   * 中转地址(配对码里的 `r`)。有它就不直连,拨号到中转进 daemon 的房间。
   * ★必须配 `pubKey`。没有身份验证的中转 = 把令牌和全部内容交给第三方,
   *  `pairingLink.ts` 和 `hostClient.ts` 两处都挡了这种组合。
   */
  relay?: string
}

export const DEFAULT_HOST_ICON = '🖥️'

/**
 * 一台主机在清单里显示的名字。
 *
 * ★空名回落成地址,不留空:清单是「切哪台」唯一的依据,一行没有名字的主机在上面认不出来。
 * ★地址去掉 `ws://` / `wss://` —— 那个前缀每一行都一模一样,占的正是最值钱的开头几个字。
 * ★同一份实现被三处用:添加主机、重命名、读盘时的字段兜底。原来是各写一遍的,
 *  于是读盘那份带着 scheme、另外两份不带 —— 同一台机器在不同路径下显示成两个名字。
 */
export function hostLabel(raw: string, url: string): string {
  return raw.trim() || url.replace(/^wss?:\/\//, '')
}

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
  // ★用自己写的解析器,不用 `new URL()` —— RN 的 URL 对 ws:// 返回空 hostname,
  //   那会让真机上每一个合法地址都被判成「缺主机名」。见 wsUrl.ts 的注释。
  const u = parseWsUrl(withScheme)
  if (!u) return { ok: false, error: '地址看不懂,应该长这样:192.168.1.10:6789' }
  if (!u.hostname) return { ok: false, error: '缺主机名或 IP' }
  if (!u.port) return { ok: false, error: '缺端口 —— daemon 默认监听 6789' }
  if (+u.port < 1 || +u.port > 65535) return { ok: false, error: `端口 ${u.port} 不是有效端口` }
  return { ok: true, url: `${u.protocol}//${u.hostname}:${u.port}` }
}

/** 这个地址是不是只有本机连得到 —— 决定要不要强制令牌。 */
export function isLoopbackUrl(url: string): boolean {
  const u = parseWsUrl(url)
  return !!u && isLoopbackHost(u.hostname)
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
        label: hostLabel(typeof h.label === 'string' ? h.label : '', h.url),
        url: h.url,
        token: typeof h.token === 'string' ? h.token : '',
        icon: typeof h.icon === 'string' ? h.icon : '',
        lastConnectedAt: typeof h.lastConnectedAt === 'number' ? h.lastConnectedAt : 0,
        // ★★这两行原来**不在**这儿。它俩是第三期(端到端加密 + 中转)加的字段,运行时一直在用
        //  (`conn.tsx` 拿它们决定走明文直连还是加密中转),但这趟逐字段兜底把它们丢了 ——
        //  于是配好的中转主机**杀进程重开之后退回直连、然后连不上**,而界面上只写着「连接失败」。
        //  中转刚在真机上验通,验的却是**同一次运行**里的内存;重启这一路从来没人走过。
        // ★空串一律落成 undefined:下游判的是「有没有」,一个空串的 relay 会让它以为该走中转,
        //  然后去拨一个空地址。
        pubKey: typeof h.pubKey === 'string' && h.pubKey ? h.pubKey : undefined,
        relay: typeof h.relay === 'string' && h.relay ? h.relay : undefined,
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
