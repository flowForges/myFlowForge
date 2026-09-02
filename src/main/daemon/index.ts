/**
 * 无头 daemon 入口。跟 Electron 外壳装载的是**同一份核心**(设计文档决策 1)——
 * 同一张方法表、同一个广播总线,只是宿主能力换成了无头实现。
 *
 * 用法:
 *   myflowforge daemon --listen 127.0.0.1:6767   起 daemon(默认就是这个地址)
 *   myflowforge daemon pair                       打印连接信息(地址 + 令牌)
 *   myflowforge daemon status                     看配置与令牌状态
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

export type DaemonHandle = { port: number; host: string; close(): Promise<void> }

export async function startDaemon(opts: { listen?: string; version?: string } = {}): Promise<DaemonHandle> {
  const { host, port } = parseListen(opts.listen ?? '127.0.0.1:6767')
  const version = opts.version ?? appVersion()

  // ★非回环地址强制令牌。绑到 0.0.0.0 又不要凭据,等于把整台机器挂在公网上。
  const token = isLoopback(host) ? undefined : ensureToken()

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
  log(token ? `★已绑到非回环地址,连接需要访问令牌 —— 查看:${selfCmd()} pair --listen ${host}:${gw.port}` : '只绑回环 —— 从别的机器连请用 SSH 隧道')
  return { port: gw.port, host: gw.host, close: () => gw.close() }
}

function pair(listen?: string) {
  const { host, port } = parseListen(listen ?? '127.0.0.1:6767')
  const loop = isLoopback(host)
  const token = loop ? '' : ensureToken()
  console.log('在 app 里「添加主机」时填:')
  console.log(`  主机名   ${hostname()}`)
  if (loop) {
    console.log('  连接方式 通过 SSH 连接')
    console.log(`  SSH 目标 <你的用户名>@<这台机器的地址>`)
    console.log(`  远端端口 ${port}`)
    console.log('')
    console.log('(daemon 只绑回环,所以走 SSH 隧道。前提是你那台机器能免密登录到这里。)')
    console.log(`启动 daemon:${selfCmd()} --listen 127.0.0.1:${port}`)
  } else {
    const addrs = lanAddresses()
    console.log('  连接方式 直接连接')
    if (addrs.length === 1) console.log(`  地址     ws://${addrs[0]}:${port}`)
    else if (addrs.length > 1) {
      console.log(`  地址     ws://${addrs[0]}:${port}`)
      console.log(`           (这台机器还有别的地址:${addrs.slice(1).map((a) => `ws://${a}:${port}`).join(' ')} —— 用和对方在同一个网段的那个)`)
    } else console.log(`  地址     ws://<这台机器的地址>:${port}(当前没检测到对外网卡)`)
    console.log(`  访问令牌 ${token}`)
    console.log('')
    console.log('★令牌等于这台机器的控制权,别贴进聊天记录或截图。')
  }
}

function status() {
  const c = readDaemonConfig()
  console.log(`配置文件 ${sysFile('daemon.json')}`)
  console.log(`访问令牌 ${c.token ? '已生成(' + c.token.slice(0, 6) + '…)' : '尚未生成(只绑回环时不需要)'}`)
  console.log(`版本     ${appVersion()}`)
}

export async function runCli(argv: string[]): Promise<number> {
  const { cmd, listen } = parseArgs(argv)

  if (cmd === 'pair') { pair(listen); return 0 }
  if (cmd === 'status') { status(); return 0 }
  if (cmd !== 'start') { console.error(`不认识的命令: ${cmd}(可用:start / pair / status)`); return 2 }

  const h = await startDaemon({ listen })
  const bye = () => { void h.close().then(() => process.exit(0)) }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
  return 0
}

// 直接被 node 跑起来时才执行 CLI —— 被测试 import 时不该有副作用。
if (process.argv[1] && /daemon(\/index)?\.(js|cjs|mjs|ts)$/.test(process.argv[1])) {
  void runCli(process.argv.slice(2)).then((code) => { if (code !== 0) process.exit(code) })
}
