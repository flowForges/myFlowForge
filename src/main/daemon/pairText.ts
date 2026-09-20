import { buildPairingLink } from '@shared/remote/pairingLink'
import { qrTerminalLines } from './qrTerminal'

/**
 * `myflowforge daemon pair` 打印的那一屏。
 *
 * ★★这是无头 Linux 上**唯一**的配对入口。那台机器没有屏幕、没有设置界面,
 *  用户手里只有一条 ssh —— 设计文档第九节把这三个命令(start / pair / status)
 *  单独列成「必须有」,就是因为少了它,装完 daemon 的人根本无从拿到凭据。
 *
 * ★这一屏的规矩:**印出来的每个值都要能直接粘**,不许有 `<你的地址>` 这类占位符。
 *  占位符等于把「去哪儿查自己的 IP」这道题甩回给用户,而那正是最容易卡住的一步。
 *
 * 纯函数,不碰进程也不碰网络 —— 印什么是可以被测试钉死的。
 */

export type PairInfo = {
  /** daemon 绑的地址 / 端口(`--listen` 解析出来的) */
  host: string
  port: number
  /** 绑的是不是回环。回环 = 手机根本连不到,只能走 SSH 隧道 */
  loopback: boolean
  /** 访问令牌。回环时为空(那条路不需要) */
  token: string
  /** 这台机器的长期公钥(base64) */
  pubKey: string
  /** 机器名,给人认的 */
  name: string
  /** 本机对外的 IPv4,按网卡顺序 */
  addresses: string[]
  /** 用户覆盖的对外地址(`--address`)。云服务器上必须用它 */
  address?: string
  /** 中转地址(`--relay`)。给了就走中转,手机不必和这台在同一个网络 */
  relay?: string
  /** 怎么启动这个 daemon —— 印给用户照抄 */
  selfCmd: string
  /** 终端画不画得了二维码(没有 TTY 时只印配对码) */
  canDrawQr: boolean
}

/** 用户没指定 `--address` 时,配对码里印哪个地址。 */
export function pairAddress(i: PairInfo): string {
  if (i.address?.trim()) return i.address.trim()
  const lan = i.addresses[0]
  // ★一个对外网卡都没有时回落成回环:码里**不能**出现占位符 —— 手机端保存前一律走
  //  `parseAddress`,占位符过不去,现象是「扫进去了,但按不动保存」。
  return `${lan ?? '127.0.0.1'}:${i.port}`
}

export function pairLink(i: PairInfo): string {
  return buildPairingLink({
    address: pairAddress(i),
    token: i.token,
    label: i.name,
    // ★公钥总是带上 —— 直连和中转两条路现在都会做端到端握手(`gateway.ts` / `relayHost.ts`)。
    pubKey: i.pubKey,
    relay: i.relay?.trim() || undefined,
  })
}

export function pairLines(i: PairInfo): string[] {
  const out: string[] = []
  const say = (s = '') => out.push(s)

  if (i.loopback && !i.relay) {
    // 回环 + 没有中转:除了这台机器自己,谁都连不到那个端口。唯一的路是 SSH 隧道。
    say('daemon 只绑回环 —— 别的机器连不到那个端口,要走 SSH 隧道。')
    say('在电脑端 app 里「设置 → 远程主机 → 添加」时填:')
    say()
    say(`  名称     ${i.name}`)
    say('  连接方式 通过 SSH 连接')
    say('  SSH 目标 <你的用户名>@<这台机器的地址>')
    say(`  远端端口 ${i.port}`)
    say()
    say('  (隧道由 app 自己拉起来,用你平时 ssh 登这台机器的密钥;隧道本身就是加密的。)')
    say(`  启动 daemon:${i.selfCmd} --listen 127.0.0.1:${i.port}`)
    say()
    // ★手机上没有 SSH 那条路(`hostClient` 只会拨 ws)。不说清楚的话,用户会拿着一屏
    //  SSH 说明去手机上找输入框 —— 那个框不存在。
    say('★手机要连这台,得让 daemon 绑到对外地址,然后重新出码:')
    say(`  ${i.selfCmd} --listen 0.0.0.0:${i.port}`)
    say(`  ${i.selfCmd} pair --listen 0.0.0.0:${i.port}`)
    say('  云服务器上网卡看到的多半是内网地址,配对码里要印公网那个:')
    say(`  ${i.selfCmd} pair --listen 0.0.0.0:${i.port} --address <公网地址>:${i.port}`)
    return out
  }

  const link = pairLink(i)
  say('手机上扫这枚码;电脑端把下面那行配对码粘进「设置 → 远程主机」。')
  say()
  if (i.canDrawQr) {
    for (const l of qrTerminalLines(link)) say('  ' + l)
    say()
  } else {
    // ★没有 TTY(输出被重定向 / 在 CI 里)时画出来的是一屏乱码。那时只印配对码。
    say('  (终端不是 TTY,画不了二维码 —— 用下面那行配对码)')
    say()
  }
  say(`  配对码   ${link}`)
  say()
  say(`  名称     ${i.name}`)
  say(`  地址     ws://${pairAddress(i)}`)
  if (i.relay?.trim()) say(`  中转     ${i.relay.trim()}`)
  say(`  访问令牌 ${i.token}`)
  say(`  身份公钥 ${i.pubKey}`)
  say()
  say('★令牌等于这台机器的控制权(能起 agent、答权限门、开终端),别贴进聊天记录或截图。')
  say('★码里带着这台机器的身份公钥,连上之后是端到端加密的 —— 换了地址、换了中转,认的还是这把钥匙。')

  if (!i.address?.trim() && i.addresses.length > 1) {
    say()
    say(`这台机器还有别的地址:${i.addresses.slice(1).map((a) => `ws://${a}:${i.port}`).join('  ')}`)
    say(`和对方不在同一个网段时,换一个再跑一次:${i.selfCmd} pair --listen ${i.host}:${i.port} --address <地址>:${i.port}`)
  }
  if (!i.address?.trim() && i.addresses.length === 0) {
    say()
    say('★这台机器上没检测到对外网卡,上面那个地址是回环 —— 云服务器上请用 --address 指定公网地址。')
  }
  return out
}
