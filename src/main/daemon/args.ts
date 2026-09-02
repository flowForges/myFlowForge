/**
 * daemon CLI 的参数解析。
 *
 * ★单独抽出来是因为第一版写错过:找命令名时用了「第一个不以 - 开头的参数」,
 * 于是 `--listen 127.0.0.1:6789` 里的**地址**被当成了命令,真跑起来直接报
 * 「不认识的命令: 127.0.0.1:6789」。带值的选项必须把它的值一起跳过。
 */
export type DaemonArgs = {
  cmd: string
  /** 绑哪儿。`host:port` / `:port` / `port` */
  listen: string | undefined
  /**
   * 配对码里印哪个地址。★云服务器上**必须**能覆盖:网卡上挂的通常是内网地址
   * (10.x / 172.x),而手机要连的是公网那个 —— 自动探测在那儿一定是错的。
   */
  address: string | undefined
  /** 中转地址。给了就同时挂到中转上,NAT 后面的机器靠它才连得上。 */
  relay: string | undefined
}

const VALUED = new Set(['--listen', '--address', '--relay'])
const KEY: Record<string, keyof Omit<DaemonArgs, 'cmd'>> = {
  '--listen': 'listen',
  '--address': 'address',
  '--relay': 'relay',
}

export function parseArgs(argv: string[]): DaemonArgs {
  const args = argv.filter((a) => a !== 'daemon')
  let cmd: string | null = null
  const out: Omit<DaemonArgs, 'cmd'> = { listen: undefined, address: undefined, relay: undefined }
  // ★不能一找到命令就 break:`pair --listen 0.0.0.0:9000` 是合法写法(pair 要按这个地址
  // 决定打印 SSH 还是令牌),选项在命令后面也得认。
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (VALUED.has(a)) { out[KEY[a]!] = args[i + 1]; i++; continue }
    const eq = a.indexOf('=')
    if (eq > 0 && VALUED.has(a.slice(0, eq))) { out[KEY[a.slice(0, eq)]!] = a.slice(eq + 1); continue }
    if (a.startsWith('-')) continue
    cmd ??= a
  }
  return { cmd: cmd ?? 'start', ...out }
}
