/**
 * 无头 daemon 的端到端探针:**真 WebSocket、真协议、真 handler**。
 *
 * ★为什么要有:第一期(Windows)和第二期(Linux)都长期停在「代码写完 · 真机零验证」。
 *  iOS 那一轮的教训是六个坑**全部**只有真机撞得到,而当时 npm test 全绿、e2e 全绿、web 上正常。
 *
 * 用法(在仓库根跑 —— 它要 import 仓库的 `ws`):
 *   npm run build
 *   docker build -f Dockerfile.daemon -t mff-daemon .
 *   docker run -d --name d -p 16767:6767 mff-daemon
 *   docker exec d node /app/out/main/daemon.js pair --listen 0.0.0.0:6767   # 拿令牌
 *   node scripts/daemon-probe.mjs ws://127.0.0.1:16767 <令牌>
 *
 * ★★它**验不了 provider CLI 的登录** —— 镜像里一个 CLI 都没装,而那恰恰是设计文档
 *  第九节列的第二期最大待验项。跑绿这个探针**不等于**「Linux 那期验完了」。
 */
import WebSocket from 'ws'

const [, , url, token] = process.argv
const ws = new WebSocket(url)
let id = 1
const pending = new Map()
const results = []
const say = (ok, what, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`)
}
const invoke = (ch, args = []) =>
  new Promise((res, rej) => {
    const myId = id++
    pending.set(myId, { res, rej })
    ws.send(JSON.stringify({ t: 'req', id: myId, ch, args }))
    setTimeout(() => { if (pending.delete(myId)) rej(new Error('超时:' + ch)) }, 20000)
  })

const timeout = setTimeout(() => { say(false, '整体', '30 秒还没跑完'); process.exit(1) }, 30000)

ws.on('open', () => {})
ws.on('error', (e) => { say(false, '连上 daemon', String(e.message)); process.exit(1) })

ws.on('message', async (raw) => {
  const f = JSON.parse(String(raw))
  if (f.t === 'hello') {
    say(f.protocol === 1, '握手:protocol=1', `拿到 ${f.protocol}`)
    say(!!f.version && f.version !== '0.0.0', '握手:报出了版本号', f.version)
    say(f.authRequired === true, '★非回环地址强制要令牌')
    ws.send(JSON.stringify({ t: 'auth', token }))
    return
  }
  if (f.t === 'ready') {
    say(Array.isArray(f.methods) && f.methods.length > 100, '鉴权通过,方法表发过来了', `${f.methods?.length} 个方法`)
    say(!f.methods.includes('pet:pick-image'), '★跟设备走的方法被剔掉了(daemonTable)')
    say(f.methods.includes('chat:send'), '会话方法在')
    say(f.methods.includes('push:register'), '★推送方法在(今晚新加的)')
    try {
      const ws2 = await invoke('workspaces:list', [])
      say(Array.isArray(ws2), 'handler 真的跑起来了:workspaces:list', `${ws2?.length ?? '?'} 个工作区`)

      const providers = await invoke('agents:detect', [])
      say(Array.isArray(providers) && providers.length > 0, 'handler:agents:detect', `${providers?.length} 个 provider`)
      const withAuth = providers.filter((p) => p.auth !== undefined)
      say(withAuth.length === providers.length, '★每个 provider 都带回了 auth 字段')
      const installed = providers.filter((p) => p.installed)
      say(true, `(参考)容器里装着的 provider:${installed.length} 个 —— 空是对的,镜像里没装任何 CLI`)

      const settings = await invoke('config:get-host-settings', [])
      say(!!settings && typeof settings === 'object', 'handler:config:get-host-settings')
      say(!!settings?.push, '★推送设置在 host 那一半里', JSON.stringify(settings?.push ?? null))

      // ★★2026-08-30 查明:`term:*` **根本不在 daemon 的方法表里**。终端那一套是
      //  `index.ts` 里直接 `ipcMain.handle` 注册的,没进 `registerIpc` 那张表 ——
      //  也就是说**无头 daemon 没有终端**,而不是「有但坏了」。
      //  ★这条断言把这个事实钉住:哪天它悄悄出现在方法表里(比如有人把注册挪进 registerIpc),
      //   这里会红,提醒去确认远程终端那条路是不是真的通了。
      //  ★node-pty 本身能不能在 Linux 上编出来,是**另一件事**,用容器里直接 require 验
      //   (见 Dockerfile.daemon 上面那段注释里的命令),不能靠这条协议探针。
      say(!f.methods.includes('term:create'), '★无头 daemon 没有终端(term:* 不在方法表里,这是现状不是 bug)')
    } catch (e) {
      say(false, '调 handler', String(e.message))
    }
    clearTimeout(timeout)
    ws.close()
    const bad = results.filter((r) => !r).length
    console.log(bad === 0 ? '\n探针全过' : `\n${bad} 项没过`)
    process.exit(bad === 0 ? 0 : 1)
  }
  if (f.t === 'res') {
    const p = pending.get(f.id)
    if (!p) return
    pending.delete(f.id)
    f.ok ? p.res(f.value) : p.rej(new Error(f.error))
  }
})
