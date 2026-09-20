import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './shimMain'

/**
 * shim 运行时。这里用**真 socket、真子进程**跑,因为这一层的价值全在「真的拦住了没有」——
 * 用假对象测「有没有调 ask()」证明不了命令没被执行。
 */
let dir: string, sock: string, bin: string, marker: string
let server: net.Server | null = null
const asked: unknown[] = []

/** 一个假的「真身」:被执行到就落一个文件,这样断言的是**事实**而不是意图。 */
const REAL = (m: string) => `#!/bin/sh\necho ran > ${m}\nexit 3\n`

function serve(answer: { decision: string; message?: string }) {
  server = net.createServer((s) => {
    s.on('data', (d) => { asked.push(JSON.parse(d.toString().trim())); s.write(JSON.stringify(answer) + '\n') })
  })
  return new Promise<void>((r) => server!.listen(sock, r))
}

beforeEach(() => {
  asked.length = 0
  dir = mkdtempSync(join(tmpdir(), 'shimrt-'))
  sock = join(dir, 'a.sock')
  marker = join(dir, 'RAN')
  const realDir = join(dir, 'realbin')
  require('node:fs').mkdirSync(realDir)
  bin = join(realDir, 'git')
  writeFileSync(bin, REAL(marker)); chmodSync(bin, 0o755)
  process.env.FORGE_SHIM_DIR = join(dir, 'shims')
  process.env.FORGE_SESSION_ID = 's1'
  process.env.PATH = `${join(dir, 'shims')}:${realDir}`
})
afterEach(() => {
  server?.close(); server = null
  delete process.env.FORGE_AUTH_SOCK
  rmSync(dir, { recursive: true, force: true })
})

describe('shim 运行时', () => {
  it('★★拒绝时命令**真的没被执行** —— 这一层的全部意义就在这一条', async () => {
    await serve({ decision: 'deny', message: '你点了拒绝' })
    process.env.FORGE_AUTH_SOCK = sock
    const code = await main(['git', 'push'])
    expect(existsSync(marker), '被拒绝了却还是跑了').toBe(false)
    expect(code).toBe(126)
  })

  it('★放行时原样执行,并且**透传退出码** —— 装了 shim 和没装表现要一致', async () => {
    await serve({ decision: 'allow' })
    process.env.FORGE_AUTH_SOCK = sock
    const code = await main(['git', 'status'])
    expect(existsSync(marker)).toBe(true)
    expect(code, '真身 exit 3,shim 必须原样带回来').toBe(3)
  })

  it('★问出去的内容够中枢做判断:命令、参数、会话、cwd', async () => {
    await serve({ decision: 'allow' })
    process.env.FORGE_AUTH_SOCK = sock
    await main(['git', 'push', '--force'])
    expect(asked[0]).toMatchObject({ command: 'git', argv: ['push', '--force'], sessionId: 's1' })
    expect((asked[0] as { cwd: string }).cwd).toBeTruthy()
  })

  it('★★连不上中枢 → **拒绝**,不是放行。失败时放行等于这一层从未存在', async () => {
    process.env.FORGE_AUTH_SOCK = join(dir, 'nope.sock')
    const code = await main(['git', 'push'])
    expect(existsSync(marker)).toBe(false)
    expect(code).toBe(126)
  })

  it('★找不到真身要明确报错,不能假装成功', async () => {
    await serve({ decision: 'allow' })
    process.env.FORGE_AUTH_SOCK = sock
    expect(await main(['nosuchcmd'])).toBe(127)
  })

  it('★★找真身时排掉 shim 目录 —— 不排就是无限递归', async () => {
    // 把一个「假 shim」放进 shim 目录里冒充 git:排除逻辑对了就永远不该执行到它
    const shims = join(dir, 'shims')
    require('node:fs').mkdirSync(shims, { recursive: true })
    const trap = join(shims, 'git')
    writeFileSync(trap, `#!/bin/sh\necho trap > ${join(dir, 'TRAP')}\n`); chmodSync(trap, 0o755)
    await serve({ decision: 'allow' })
    process.env.FORGE_AUTH_SOCK = sock
    await main(['git', 'status'])
    expect(existsSync(join(dir, 'TRAP')), '调到自己身上了').toBe(false)
    expect(existsSync(marker)).toBe(true)
  })
})
