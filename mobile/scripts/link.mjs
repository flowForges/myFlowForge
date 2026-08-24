/*
 * 打印「现在这台机器上,手机该往哪儿连」。
 *
 * 存在的理由:地址每换一次网络就变一次(公司 wifi / 家里 / 手机热点各是一套),
 * 而它要手抄进两个地方 —— Expo Go 的 URL 框和 app 的「添加主机」。抄错一位的表现是
 * 「转圈然后超时」,离原因非常远。所以让机器自己念出来。
 */
import { networkInterfaces } from 'node:os'
import { execFileSync } from 'node:child_process'

const METRO_PORT = process.env.METRO_PORT || '8081'
const DAEMON_PORT = process.env.DAEMON_PORT || '6789'

/** 所有对外的 IPv4,按「手机最可能连得上」排序。 */
function addresses() {
  const out = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      out.push({ name, ip: ni.address })
    }
  }
  const rank = (ip) =>
    // iOS 个人热点固定发这一段 —— 只要看见它,那就是手机自己那张网,一定通。
    ip.startsWith('172.20.10.') ? 0
      // Parallels / Docker 的虚拟网卡,手机永远连不上,排最后。
      : ip.startsWith('10.211.55.') || ip.startsWith('10.37.129.') || ip.startsWith('172.17.') ? 9
      : ip.startsWith('192.168.') ? 1
      : 2
  return out.sort((a, b) => rank(a.ip) - rank(b.ip))
}

function token() {
  try {
    // scripts/ 在 mobile/ 下,daemon 打包产物在仓库根的 out/ —— 往上两层。
    // stderr 吞掉:daemon 还没 build 时它会喷一整段 MODULE_NOT_FOUND,而这里只是「顺带查一下」,
    // 查不到就走下面那句提示,不该把一屏报错糊在真正要看的地址上面。
    return execFileSync('node', ['../../out/main/daemon.js', 'pair', '--listen', `0.0.0.0:${DAEMON_PORT}`], {
      encoding: 'utf8', cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'],
    }).match(/访问令牌\s+(\S+)/)?.[1] ?? null
  } catch {
    return null
  }
}

const list = addresses()
if (!list.length) {
  console.log('没有检测到对外的网卡 —— 先把这台机器连上一个网络(手机热点最省事)。')
  process.exit(1)
}

const best = list[0]
const hotspot = best.ip.startsWith('172.20.10.')

console.log('')
console.log(`  这台机器的地址   ${best.ip}   (${best.name}${hotspot ? ' · 看着像手机热点,对了' : ''})`)
if (list.length > 1) {
  console.log(`  另外还有         ${list.slice(1).map((a) => `${a.ip}(${a.name})`).join('  ')}`)
  console.log('                   用和手机在同一个网段的那个。虚拟网卡(10.211.55/10.37.129)手机永远连不上。')
}
console.log('')
console.log('  ① Expo Go 里手输(首页 → Enter URL manually):')
console.log(`       exp://${best.ip}:${METRO_PORT}`)
console.log('')
console.log('  ② app 里「添加主机」:')
console.log(`       地址     ${best.ip}:${DAEMON_PORT}`)
const t = token()
console.log(t ? `       访问令牌 ${t}` : '       访问令牌 跑一下 `node out/main/daemon.js pair --listen 0.0.0.0:6789` 看')
console.log('')
if (!hotspot) {
  console.log('  ⚠ 没看到手机热点那一段(172.20.10.x)。如果这台机器在公司 guest 网上,')
  console.log('    手机多半连不过来 —— guest 网基本都开客户端隔离。改成「手机开热点、这台机器连手机」最省事。')
  console.log('')
}
