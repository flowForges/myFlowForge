import { createServer } from 'node:http'
import { startRelay } from './node'

/**
 * 可执行入口。`node relay.js` / `docker run` 跑的就是它。
 *
 * ★★**它不需要任何配置文件、任何账号、任何密钥。** 起来就能用 —— 这是"自建中转"
 *  这条路成立的前提:如果部署它需要先想清楚十个选项,那"三五分钟搞定"就是假的。
 *
 * 环境变量(全都可以不给):
 *   PORT        监听端口,默认 8787
 *   HOST        绑哪个地址,默认 0.0.0.0
 *   HEALTH_PORT 健康检查端口,默认和 PORT 同一个(走 HTTP GET /healthz)
 *
 * ⚠️ **别把自己的小带宽 VPS 当公共中转。** 中转是全流量转发 —— 你的带宽会被所有用它的人
 *  一起花掉。放 Cloudflare 上带宽是 Cloudflare 出的;VPS 应该留着跑 daemon。
 */

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'

async function main() {
  const log = (m: string) => console.log(`[relay] ${new Date().toISOString()} ${m}`)

  // ★健康检查和 WebSocket 共用一个端口:`ws` 的 server 是挂在一个 http server 上的,
  //  所以顺手就能给一个 `/healthz`。分两个端口只会让 Docker/反代的配置多一行。
  const http = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      // ★★这里**只报数字**,不报房间号 —— 房间号是 daemon 的公钥,是可关联的信息。
      //  一个健康检查端点不该变成"谁在用这台中转"的名单。
      res.end(JSON.stringify({ ok: true, ...relay.stats() }))
      return
    }
    res.writeHead(404).end()
  })

  const relay = await startRelay({ port: PORT, host: HOST, onLog: log, server: http })
  http.listen(PORT, HOST, () => log(`中转在 ws://${HOST}:${PORT} · 健康检查 /healthz`))

  const stop = async (sig: string) => {
    log(`收到 ${sig},关闭中`)
    await relay.close()
    http.close(() => process.exit(0))
    // ★兜底:还有连接挂着时 `http.close` 的回调不会触发。给两秒,然后硬退 ——
    //  一个卡在关闭中的中转比一个立刻退出的更糟(容器编排会以为它还活着)。
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

void main().catch((e) => {
  console.error('[relay] 起不来:', e)
  process.exit(1)
})
