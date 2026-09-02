import { describe, it, expect, afterAll } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectRemote, type RemoteState } from '../remote/remoteClient'
import { parsePairingLink } from '@shared/remote/pairingLink'

/**
 * **真的把 daemon 当成一个进程跑起来**,照着 Linux 服务器上那条路走一遍:
 * `daemon --listen 0.0.0.0:<port>` → `daemon pair` → 把印出来的配对码解开 →
 * 拿里面那把公钥连上去(直连 + 端到端加密)→ invoke 一个真方法。
 *
 * ★★为什么单元测试不够:那些测的是 `src/` 里的源码,而服务器上跑的是 `out/main/daemon.js`
 *  那个**打包产物**。这条路上每一个环节都只有真进程才验得到 —— 打包后 `readIdentity`
 *  还在不在、CLI 参数解析对不对、`pair` 印出来的码和网关认的是不是同一把钥匙。
 *
 * ★要 `npm run build` 先出产物,所以默认**跳过**(`npm test` 不该依赖构建过)。跑法:
 *    npm run build && npm run check:daemon
 *
 * ★★HOME 指到一个临时目录 —— daemon 会往 `~/.myFlowForge/` 写身份和令牌,
 *  不隔离的话这条检查会动到你真在用的那份配置。
 */

const BUNDLE = join(process.cwd(), 'out/main/daemon.js')
const ENABLED = !!process.env.FORGE_DAEMON_CHECK
const PORT = Number(process.env.FORGE_DAEMON_PORT ?? 6793)

let child: ChildProcess | null = null
afterAll(() => { child?.kill('SIGTERM') })

describe('真 daemon 进程(打包产物)', () => {
  it.runIf(ENABLED)('起得来 → pair 出的码解得开 → 拿那把公钥连上去能 invoke', async () => {
    expect(existsSync(BUNDLE), `没有 ${BUNDLE},先跑 npm run build`).toBe(true)
    const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'mff-daemon-')) }

    child = spawn('node', [BUNDLE, '--listen', `0.0.0.0:${PORT}`], { env, stdio: 'pipe' })
    let out = ''
    child.stdout?.on('data', (d) => { out += String(d) })
    child.stderr?.on('data', (d) => { out += String(d) })
    for (let i = 0; i < 150 && !out.includes('监听'); i++) await new Promise((r) => setTimeout(r, 100))
    expect(out, out).toContain('监听')

    // ★`--address` 指定成回环:这台机器上要连的就是它。真服务器上这里填公网地址。
    const printed = execFileSync(
      'node', [BUNDLE, 'pair', '--listen', `0.0.0.0:${PORT}`, '--address', `127.0.0.1:${PORT}`],
      { env, encoding: 'utf8' },
    )
    const line = printed.split('\n').find((l) => l.includes('myflowforge://'))
    expect(line, printed).toBeTruthy()
    const parsed = parsePairingLink(line!.replace(/^\s*配对码\s*/, '').trim())
    if (!parsed.ok) throw new Error(`pair 印出来的码手机端解不开:${parsed.error}\n${line}`)
    // ★码里必须有公钥和令牌 —— 少任何一个,这条路就退回明文了
    expect(parsed.value.pubKey).toBeTruthy()
    expect(parsed.value.token).toBeTruthy()

    const c = connectRemote({
      url: `ws://${parsed.value.address}`,
      token: parsed.value.token,
      pubKey: parsed.value.pubKey,
      clientVersion: '1.2.0',
      onEvent: () => {},
      backoff: false,
      readyTimeoutMs: 8000,
    })
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`没 ready:${JSON.stringify(c.state())}\n${out}`)), 8000)
      const done = (e?: Error) => { clearTimeout(t); off(); e ? rej(e) : res() }
      const off = c.onState((s: RemoteState) => {
        if (s.status === 'ready') done()
        if (s.status === 'failed') done(new Error(`${s.error}\n--- daemon 日志 ---\n${out}`))
      })
      if (c.state().status === 'ready') done()
    })
    // 握完手之后跑一个真方法 —— 只到 ready 证明不了方法表也活着
    expect(Array.isArray(await c.invoke('workspaces:list', []))).toBe(true)
    // ★网关那一侧要留下这一行。没有它就说明它走的是明文,只是碰巧也能连上。
    expect(out).toContain('客户端要求端到端加密')
    await c.close()
  }, 60_000)

  it.skipIf(ENABLED)('(默认跳过 —— 要先 npm run build,跑法见文件顶部)', () => {
    expect(true).toBe(true)
  })
})
