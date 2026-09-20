/**
 * 无头 daemon 的端到端探针:**真 WebSocket、真协议、真 handler、真 pty**。
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

// 终端输出是**事件**推回来的(`evt` 帧),不是 res —— 所以要单独攒一份缓冲。
const PROBE_TERM = 'probe-term-1'
let termBuf = ''
const termWaiters = []
const onTermData = (chunk) => {
  termBuf += chunk
  for (const w of termWaiters.splice(0)) {
    if (termBuf.includes(w.needle)) w.res(true)
    else termWaiters.push(w)
  }
}
const waitForTermOutput = (needle, ms) => new Promise((res) => {
  if (termBuf.includes(needle)) return res(true)
  const w = { needle, res }
  termWaiters.push(w)
  setTimeout(() => { const i = termWaiters.indexOf(w); if (i >= 0) { termWaiters.splice(i, 1); res(false) } }, ms)
})

const timeout = setTimeout(() => { say(false, '整体', '60 秒还没跑完'); process.exit(1) }, 60000)

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

      // ── 终端 ──────────────────────────────────────────────────────────────
      // ★★2026-09-03 之前这里断言的是**反面**:`term:*` 不在方法表里,无头 daemon 没有终端。
      //  那是当时的事实 —— 终端是 `index.ts` 里直接 `ipcMain.handle` 注册的,没进那张表,
      //  所以「在 mac 上用 app 连这台 Linux,开个终端跑一下测试」是做不到的。现在它进表了。
      //
      // ★这几行是这个探针里**唯一**验得到 node-pty 真在 Linux 上跑起来的地方:
      //  它不是 `require('node-pty')` 那种加载检查,是**完整走一遍**
      //  开 pty → 往里写命令 → 从这条 WebSocket 上读回它的输出。
      say(f.methods.includes('term:create'), '★终端在方法表里(远程/无头都能开 shell)')
      const started = await invoke('term:create', [{ termId: PROBE_TERM, cols: 80, rows: 24 }])
      say(started?.ok === true, '★在这台 Linux 上真的起了一个 pty(node-pty 编得过也跑得动)', started?.error ?? '')
      if (started?.ok) {
        // ★故意让**命令本身**和**它的输出**长得不一样:shell 会把你敲的那一行回显出来,
        //  只找一个固定字符串的话,回显就足以让断言变绿 —— 那证明不了命令被执行过。
        //  `$((6*7))` 只有真的被 shell 求值了才会变成 42。
        await invoke('term:write', [{ termId: PROBE_TERM, data: 'echo "$((6*7))-PTYOK"\n' }])
        const hit = await waitForTermOutput('42-PTYOK', 15000)
        say(hit, '★★写进去的命令在这台机器上真的执行了(回读到 42-PTYOK)',
          hit ? '' : `只读到:${JSON.stringify(termBuf.slice(-200))}`)
        await invoke('term:kill', [{ termId: PROBE_TERM }])
        say(true, '(参考)已关掉探针开的终端 —— 容器里不该留下 shell')
      }
    } catch (e) {
      say(false, '调 handler', String(e.message))
    }
    clearTimeout(timeout)
    ws.close()
    const bad = results.filter((r) => !r).length
    console.log(bad === 0 ? '\n探针全过' : `\n${bad} 项没过`)
    process.exit(bad === 0 ? 0 : 1)
  }
  if (f.t === 'evt') {
    if (f.ch === 'term:data' && f.payload?.termId === PROBE_TERM) onTermData(String(f.payload.data ?? ''))
    return
  }
  if (f.t === 'res') {
    const p = pending.get(f.id)
    if (!p) return
    pending.delete(f.id)
    f.ok ? p.res(f.value) : p.rej(new Error(f.error))
  }
})
