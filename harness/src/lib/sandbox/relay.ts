// 设计参考 anthropic-experimental/sandbox-runtime(Apache-2.0)
// Linux 网络命名空间里的中转(spec §9,R9)。bwrap 以 `<execPath> -e RELAY_SOURCE <port> <unixSock> /bin/sh -c <command>` 起它:
// - 在命名空间私有的 127.0.0.1:<port> 上监听,每个连接原样转到绑进来的 Unix socket(宿主上的白名单代理);
// - 监听成功后才起命令;命令的环境里删掉 ELECTRON_RUN_AS_NODE(中转自己要它,命令里起的 Electron 应用不能要);
// - 命令结束就退出(不等还开着的连接),退出码 / 信号原样带出;收到 TERM / INT / HUP 转给命令。
// 内联源码:不能 import,不能依赖 harness 的打包产物(只读根里只看得到 execPath 自己)。

/** 命名空间里代理的 TCP 端口;沙箱环境的 HTTPS_PROXY 指向 http://127.0.0.1:<它> */
export const RELAY_PORT = 3128

/** 中转不能起来时的退出码(监听失败、参数不对);命令找不到是 127 */
export const RELAY_FAILED = 125

export const RELAY_SOURCE = String.raw`'use strict'
const net = require('net')
const { spawn } = require('child_process')
const { constants } = require('os')
const [port, sock, file, ...args] = process.argv.slice(1)
const fail = (m) => { try { process.stderr.write('mffai relay: ' + m + '\n') } catch {} ; process.exit(${RELAY_FAILED}) }
if (!/^[0-9]+$/.test(port || '') || !sock || !file) fail('usage: <port> <unixSock> <file> [args...]')
const srv = net.createServer({ allowHalfOpen: true }, (c) => {
  const u = net.connect({ path: sock, allowHalfOpen: true })
  const kill = () => { c.destroy(); u.destroy() }
  c.on('error', kill); u.on('error', kill)
  c.on('close', kill); u.on('close', kill)
  c.pipe(u); u.pipe(c)
})
srv.on('error', (e) => fail('listen 127.0.0.1:' + port + ': ' + e.message))
srv.listen(Number(port), '127.0.0.1', () => {
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  let child
  try { child = spawn(file, args, { stdio: 'inherit', env }) } catch (e) { fail('spawn: ' + e.message) }
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { try { child.kill(s) } catch {} })
  child.on('error', (e) => { try { process.stderr.write('mffai relay: ' + e.message + '\n') } catch {} ; process.exit(127) })
  child.on('exit', (code, signal) => {
    if (signal) {
      for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeAllListeners(s)
      try { process.kill(process.pid, signal) } catch {}
      // 自己被忽略的信号(如 SIGPIPE)杀不死 → 按 shell 的约定 128+n
      setTimeout(() => process.exit(128 + (constants.signals[signal] || 0)), 100)
      return
    }
    process.exit(code === null ? 1 : code)
  })
})
`
