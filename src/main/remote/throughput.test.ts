import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { startGateway } from './gateway'
import { createBroadcastHub } from '../ipc/broadcastHub'
import { decodeFrame, encodeFrame } from '@shared/remote/protocol'

/**
 * 链路吞吐实测 —— 用来给「远程终端限速」定参数(设计文档「未决问题」第 3 条:
 * 「太严看不到东西,太松堵死链路」,而且原话是**要先有链路才能量**)。
 *
 * 量的是本机回环上的 WS 网关,也就是这条链路的**上限**;走 SSH 隧道或中转只会更慢。
 * 所以这里的数字是「不可能超过」的那条线,限速参数必须明显低于它。
 *
 * 断言用的是很宽松的下限:这是回归护栏(别哪天把分帧改成一条一个 TCP 包),不是性能指标。
 */
const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

async function bench(chunkBytes: number, count: number) {
  const hub = createBroadcastHub()
  const payload = 'x'.repeat(chunkBytes)
  const gw = await startGateway({
    table: {
      'term:flood': (ctx) => { for (let i = 0; i < count; i++) ctx.emit('term:data', { termId: 't', data: payload }); return count },
    },
    addSink: hub.addSink, version: '1.1.2', port: 0,
  })
  closers.push(() => gw.close())

  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}`)

  let got = 0
  let t0 = 0
  // ★监听必须在 await open 之前挂上:hello/ready 完全可能在 open 回调和挂监听之间就到了,
  //   那样就永远等不到 ready,也就永远不会发出请求 —— 表现为「测试超时」而不是任何有用的错误。
  const done = new Promise<number>((resolve) => {
    ws.on('message', (raw) => {
      const d = decodeFrame(String(raw))
      if (!d.ok) return
      if (d.frame.t === 'ready') { t0 = performance.now(); ws.send(encodeFrame({ t: 'req', id: 1, ch: 'term:flood', args: [] })); return }
      if (d.frame.t === 'evt') { got++; if (got === count) resolve(performance.now() - t0) }
    })
  })
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
  const ms = await done
  ws.close()
  return { ms, bytes: chunkBytes * count, mbPerSec: (chunkBytes * count) / 1024 / 1024 / (ms / 1000), evPerSec: count / (ms / 1000) }
}

describe('远程链路吞吐(本机回环 = 上限)', () => {
  it('小块高频:80 字节 × 2000 条', async () => {
    const r = await bench(80, 2000)
    console.log(`  小块高频 80B×2000 → ${r.ms.toFixed(0)}ms · ${Math.round(r.evPerSec)} 条/秒 · ${r.mbPerSec.toFixed(2)} MB/s`)
    expect(r.evPerSec).toBeGreaterThan(500)
  }, 30_000)

  it('中块:4KB × 500 条(TermBatcher 合并后的典型形状)', async () => {
    const r = await bench(4096, 500)
    console.log(`  中块 4KB×500 → ${r.ms.toFixed(0)}ms · ${Math.round(r.evPerSec)} 条/秒 · ${r.mbPerSec.toFixed(2)} MB/s`)
    expect(r.evPerSec).toBeGreaterThan(200)
  }, 30_000)

  it('★大块:256KB × 40 条(TermBatcher 现在的单条上限)', async () => {
    // 这就是 `npm run build` 刷屏时的真实形状。本机 IPC 无所谓,走网络就是这条链路的压力测试。
    const r = await bench(256 * 1024, 40)
    console.log(`  大块 256KB×40 → ${r.ms.toFixed(0)}ms · ${Math.round(r.evPerSec)} 条/秒 · ${r.mbPerSec.toFixed(2)} MB/s`)
    expect(r.mbPerSec).toBeGreaterThan(5)
  }, 30_000)
})
