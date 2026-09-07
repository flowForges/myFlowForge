import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAuthBroker, type AuthBroker } from './authBroker'

/**
 * 授权中枢。shim(以后还有 hook)把请求送到这里,这里**复用 app 已有的那道门** ——
 * 所以「完全访问自动放行」「工具卡上的 🛡」这些行为全部免费继承,不会出现两套权限语义。
 */
let dir: string, sock: string, b: AuthBroker | null = null
const asked: { title: string; where?: string; sessionId: string }[] = []
let answer: 'allow' | 'deny' = 'allow'

const call = (payload: unknown): Promise<Record<string, unknown>> => new Promise((res, rej) => {
  let buf = ''
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\n'))
  c.on('data', d => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { res(JSON.parse(buf.slice(0, nl))); c.end() } })
  c.on('error', rej)
})

beforeEach(async () => {
  asked.length = 0; answer = 'allow'
  dir = mkdtempSync(join(tmpdir(), 'broker-'))
  sock = join(dir, 'a.sock')
  b = await startAuthBroker(sock, { confirm: async (r) => { asked.push(r); return answer } })
})
afterEach(async () => { await b?.close(); b = null; rmSync(dir, { recursive: true, force: true }) })

describe('授权中枢', () => {
  it('★★不需要授权的命令**直接放行,连门都不弹** —— git status 一轮十几次,弹一次这功能就废了', async () => {
    const r = await call({ type: 'exec', sessionId: 's1', command: 'git', argv: ['status'], cwd: '/w' })
    expect(r.decision).toBe('allow')
    expect(asked, '给 git status 弹了门').toEqual([])
  })

  it('★★不可逆的命令才弹门,而且把完整命令摆给用户看', async () => {
    const r = await call({ type: 'exec', sessionId: 's1', command: 'git', argv: ['push', '--force'], cwd: '/w' })
    expect(r.decision).toBe('allow')
    expect(asked).toHaveLength(1)
    expect(asked[0].title).toContain('git push')
    expect(asked[0].where, '用户得看见到底要跑什么').toContain('--force')
    expect(asked[0].sessionId).toBe('s1')
  })

  it('★用户点拒绝 → 回 deny,并带一句能显示给模型的话', async () => {
    answer = 'deny'
    const r = await call({ type: 'exec', sessionId: 's1', command: 'rm', argv: ['-rf', '/w/build'], cwd: '/w' })
    expect(r.decision).toBe('deny')
    expect(String(r.message ?? '')).not.toBe('')
  })

  it('★★门抛异常 → deny,不能因为 UI 出问题就把不可逆的命令放出去', async () => {
    await b!.close()
    b = await startAuthBroker(sock, { confirm: async () => { throw new Error('gate torn down') } })
    const r = await call({ type: 'exec', sessionId: 's1', command: 'git', argv: ['push'], cwd: '/w' })
    expect(r.decision).toBe('deny')
  })

  it('★垃圾输入不能把中枢打挂,而且要 deny', async () => {
    const c = net.createConnection(sock, () => c.write('这不是 json\n'))
    const got = await new Promise<string>(res => c.on('data', d => { res(d.toString()); c.end() }))
    expect(JSON.parse(got.trim()).decision).toBe('deny')
    // 还活着
    expect((await call({ type: 'exec', sessionId: 's1', command: 'git', argv: ['status'], cwd: '/w' })).decision).toBe('allow')
  })

  it('★认不出的请求类型 → deny(以后加 hook 通道时,老版本 shim 不能被默认放行)', async () => {
    expect((await call({ type: '未来的什么东西' })).decision).toBe('deny')
  })

  it('★★多个 shim 同时问 —— 一轮里 agent 可能并行跑好几条命令,不能串答案', async () => {
    const [a, b2] = await Promise.all([
      call({ type: 'exec', sessionId: 's1', command: 'git', argv: ['push'], cwd: '/w' }),
      call({ type: 'exec', sessionId: 's1', command: 'git', argv: ['status'], cwd: '/w' }),
    ])
    expect(a.decision).toBe('allow')
    expect(b2.decision).toBe('allow')
    expect(asked, '只有 push 该弹门').toHaveLength(1)
  })
})
