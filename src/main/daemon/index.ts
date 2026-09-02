/**
 * 无头 daemon 入口。跟 Electron 外壳装载的是**同一份核心**(设计文档决策 1)——
 * 同一张方法表、同一个广播总线,只是宿主能力换成了无头实现。
 *
 * 用法:
 *   myflowforge daemon --listen 127.0.0.1:6767            起 daemon(默认就是这个地址)
 *   myflowforge daemon --listen 0.0.0.0:6767              让别的机器连得到(强制要令牌)
 *   myflowforge daemon --relay wss://中转地址/             NAT 后面的机器靠它才被连得上
 *   myflowforge daemon pair [--address 公网地址:端口]      终端里画出配对二维码 + 配对码
 *   myflowforge daemon status                             看配置、令牌、身份公钥
 *
 * ★默认只绑回环。要连它,在你自己那台机器上用 SSH 隧道(app 里选「通过 SSH 连接」即可)。
 *   这不是图省事:这个端口一旦被敲开,对方拿到的是「起 agent + 替你答权限门 + 开终端」,
 *   等于整台机器的控制权。见决策 B-3。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname, networkInterfaces } from 'node:os'
import { registerIpc } from '../ipc/handlers'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { daemonTable } from '../ipc/channelRouting'
import { createHeadlessHost } from '../host/headlessHost'
import { buildProviderRegistry } from '../agents/registry'
import { startGateway } from '../remote/gateway'
import { ensureToken, isLoopback, parseListen, readDaemonConfig } from './config'
import { readIdentity } from '../remote/identity'
import { startRelayHost, type RelayHostHandle } from '../remote/relayHost'
import { toBase64 } from '@shared/remote/e2e'
import { pairLines } from './pairText'
import { canDrawQr } from './qrTerminal'
import { sysFile } from '../config/paths'
import { parseArgs } from './args'

function appVersion(): string {
  // 打包后 package.json 在上一层;开发时在仓库根。读不到不该让 daemon 起不来。
  for (const p of [join(__dirname, '..', 'package.json'), join(__dirname, '..', '..', 'package.json')]) {
    try { return String(JSON.parse(readFileSync(p, 'utf8')).version) } catch { /* 试下一个 */ }
  }
  return '0.0.0'
}

const log = (m: string) => console.log(`[daemon] ${m}`)

/**
 * 这台机器上别人连得到的 IPv4 地址。
 * ★打印真实地址而不是 `<这台机器的地址>` 这种占位符 —— 占位符等于把「去哪儿查自己的 IP」
 * 这道题甩回给用户,而这一步本来就是他最容易卡住的地方。
 */
function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address)
    }
  }
  return out
}

/** 当前这个 daemon 实际是怎么被启动的 —— 打印给用户照抄。目前没有打包好的可执行文件。 */
const selfCmd = () => `node ${process.argv[1] ?? 'out/main/daemon.js'}`

/** `srv-1.local` → `srv-1`。那个后缀对人没有信息量。 */
const machineName = () => hostname().replace(/\.local$/i, '')

export type DaemonHandle = { port: number; host: string; close(): Promise<void> }

export async function startDaemon(
  opts: { listen?: string; version?: string; relay?: string } = {},
): Promise<DaemonHandle> {
  const { host, port } = parseListen(opts.listen ?? '127.0.0.1:6767')
  const version = opts.version ?? appVersion()
  const relayUrl = opts.relay?.trim() || ''

  // ★非回环地址强制令牌。绑到 0.0.0.0 又不要凭据,等于把整台机器挂在公网上。
  // ★★中转那条路**一律**要令牌,哪怕网关只绑了回环:中转是一根不可信的哑管道,
  //  谁知道房间号谁就能拨进来,而房间号是从公钥算的、公钥印在配对码里。
  const token = isLoopback(host) && !relayUrl ? undefined : ensureToken()

  const hub = createBroadcastHub()
  const caps = createHeadlessHost({ version, onLog: log })
  const full = registerIpc(hub.broadcast, buildProviderRegistry(), caps)
  const table = daemonTable(full)

  const gw = await startGateway({
    table, addSink: hub.addSink, version, host, port, token, onLog: log,
    // ★★没有它,`daemon pair` 印出来的码里那把公钥就是个摆设:客户端看到公钥就发 hs-init,
    //  而不会握手的网关只会回明文 hello,对面直接判「形状不对」断开。
    //  云服务器那条路(绑 0.0.0.0、走公网)尤其不能少 —— 那上面明文等于把令牌摊在路上。
    identity: readIdentity(),
  })

  log(`myFlowForge daemon ${version} · ${hostname()}`)
  log(`监听 ${gw.host}:${gw.port} · 对外提供 ${Object.keys(table).length} 个方法(共 ${Object.keys(full).length} 个,其余跟设备走)`)
  log(token ? `★需要访问令牌 —— 查看:${selfCmd()} pair --listen ${host}:${gw.port}` : '只绑回环 —— 从别的机器连请用 SSH 隧道')

  /**
   * 中转。★这是**无头机器唯一能被 NAT 后面连上的方式** —— 桌面端那边由
   * `relayController` 干同一件事,这里是它在 daemon 侧的对应物(同一个 `startRelayHost`)。
   * 有公网 IP 的云服务器不需要它:那种机器直连就够,少一跳更快也更少一个可信方。
   */
  let relay: RelayHostHandle | null = null
  if (relayUrl) {
    relay = startRelayHost({
      relayUrl,
      identity: readIdentity(),
      table,
      addSink: hub.addSink,
      version,
      token,
      onLog: log,
      onStatus: (st) => {
        // 中转的状态是这条路上唯一看得见的东西 —— 无头机器上没有界面,不打日志就是全黑的。
        if (st.status === 'online') log(`中转已连上 · 现在挂着 ${st.peers} 个客户端`)
        else if (st.status === 'retrying') log(`中转断了(${st.error}),${Math.round(st.nextInMs / 1000)} 秒后重试`)
        else if (st.status === 'failed') log(`★中转连不上:${st.error}`)
      },
    })
    log(`已挂到中转 ${relayUrl} · 房间 ${relay.room}`)
  }

  return {
    port: gw.port,
    host: gw.host,
    async close() {
      await relay?.close()
      await gw.close()
    },
  }
}

function pair(a: { listen?: string; address?: string; relay?: string }) {
  const { host, port } = parseListen(a.listen ?? '127.0.0.1:6767')
  const loopback = isLoopback(host)
  const relay = a.relay?.trim() || ''
  // ★令牌要和 `startDaemon` 算出来的**一模一样**:那边中转开着就一定有令牌,
  //  这边算漏了的话,印出来的码连上去会被 4403 断掉,而界面上只写着「连接失败」。
  const token = loopback && !relay ? '' : ensureToken()
  for (const line of pairLines({
    host, port, loopback, token,
    pubKey: toBase64(readIdentity().publicKey),
    name: machineName(),
    addresses: lanAddresses(),
    address: a.address,
    relay,
    selfCmd: selfCmd(),
    canDrawQr: canDrawQr(),
  })) console.log(line)
}

function status() {
  const c = readDaemonConfig()
  console.log(`配置文件 ${sysFile('daemon.json')}`)
  console.log(`访问令牌 ${c.token ? '已生成(' + c.token.slice(0, 6) + '…)' : '尚未生成(只绑回环时不需要)'}`)
  // ★身份公钥要印全:它是整条链路的信任锚点,而且**换了就等于所有配过对的设备全部作废**。
  //  出问题时第一件要对的就是"两边看到的是不是同一把"。
  console.log(`身份公钥 ${toBase64(readIdentity().publicKey)}`)
  console.log(`版本     ${appVersion()}`)
}

export async function runCli(argv: string[]): Promise<number> {
  const { cmd, listen, address, relay } = parseArgs(argv)

  if (cmd === 'pair') { pair({ listen, address, relay }); return 0 }
  if (cmd === 'status') { status(); return 0 }
  if (cmd !== 'start') { console.error(`不认识的命令: ${cmd}(可用:start / pair / status)`); return 2 }

  const h = await startDaemon({ listen, relay })
  const bye = () => { void h.close().then(() => process.exit(0)) }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
  return 0
}

// 直接被 node 跑起来时才执行 CLI —— 被测试 import 时不该有副作用。
if (process.argv[1] && /daemon(\/index)?\.(js|cjs|mjs|ts)$/.test(process.argv[1])) {
  void runCli(process.argv.slice(2)).then((code) => { if (code !== 0) process.exit(code) })
}
