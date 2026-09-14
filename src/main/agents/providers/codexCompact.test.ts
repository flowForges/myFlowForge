import { describe, it, expect } from 'vitest'
import { compactCodexThread, type CompactChild } from './codexCompact'

// 可编排的假 app-server:记下我们写出去的每一行,让用例自己往 stdout 推。
function fakeChild() {
  let onData: ((c: Buffer) => void) | undefined
  let onClose: ((a?: unknown) => void) | undefined
  const writes: any[] = []
  const child: CompactChild = {
    stdin: { write: (s: string) => { for (const ln of s.split('\n')) if (ln.trim()) writes.push(JSON.parse(ln)) } },
    stdout: { on: (_e, cb) => { onData = cb } },
    stderr: { on: () => {} },
    on: (e, cb) => { if (e === 'close') onClose = cb },
    kill: () => {},
  }
  const push = (o: any) => onData?.(Buffer.from(JSON.stringify(o) + '\n'))
  return { child, writes, push, close: () => onClose?.() }
}
const tick = () => new Promise(r => setTimeout(r, 0))

/**
 * 用户 2026-09-14 要的「手动压缩上下文」。codex 这边是协议原生的:`thread/compact/start`。
 *
 * ★另起一个 app-server 是必须的:driveCodexTurn 一轮一个进程,跑完就杀。用户点压缩时没有活着的
 *  服务端可用,只能靠 `thread/resume` 把磁盘上的 thread 捞回来 —— 这也是 codex CLI 自己的做法。
 */
describe('compactCodexThread', () => {
  it('握手 → 恢复会话 → 发压缩请求,收到 thread/compacted 就算成功', async () => {
    const f = fakeChild()
    const p = compactCodexThread('th-1', { spawn: () => f.child })

    expect(f.writes[0].method).toBe('initialize')
    f.push({ id: f.writes[0].id, result: {} })
    await tick()

    expect(f.writes.some(w => w.method === 'initialized')).toBe(true)
    const resume = f.writes.find(w => w.method === 'thread/resume')
    expect(resume.params).toEqual({ threadId: 'th-1' })
    f.push({ id: resume.id, result: { thread: { id: 'th-1' } } })
    await tick()

    const compact = f.writes.find(w => w.method === 'thread/compact/start')
    // schema(ThreadCompactStartParams)的必填字段只有 threadId。
    expect(compact.params).toEqual({ threadId: 'th-1' })

    f.push({ method: 'thread/compacted', params: { threadId: 'th-1' } })
    await expect(p).resolves.toBeUndefined()
  })

  it('★★新版本 codex 不发 thread/compacted,只发 contextCompaction 的 item/completed', async () => {
    // 2026-09-14 真机抓包(0.153.4):压缩 7 秒就完成了,但等 thread/compacted 的那一版界面上
    // 「压缩中…」一直转到 3 分钟超时。两代信号都要认。
    const f = fakeChild()
    const p = compactCodexThread('th-1', { spawn: () => f.child })
    f.push({ id: f.writes[0].id, result: {} })
    await tick()
    const resume = f.writes.find(w => w.method === 'thread/resume')
    f.push({ id: resume.id, result: {} })
    await tick()
    const compact = f.writes.find(w => w.method === 'thread/compact/start')
    f.push({ id: compact.id, result: {} })            // 回包只是「已受理」,不能当完成
    f.push({ method: 'turn/started', params: {} })
    f.push({ method: 'item/started', params: { item: { type: 'contextCompaction', id: 'i1' } } })
    f.push({ method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'i1' } } })
    await expect(p).resolves.toBeUndefined()
  })

  it('别的 item 完成不算数 —— 只认 contextCompaction 那一种', async () => {
    const f = fakeChild()
    let done = false
    const p = compactCodexThread('th-1', { spawn: () => f.child, timeoutMs: 40 }).then(() => { done = true }).catch(() => {})
    f.push({ id: f.writes[0].id, result: {} })
    await tick()
    f.push({ id: f.writes.find(w => w.method === 'thread/resume').id, result: {} })
    await tick()
    f.push({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'x' } } })
    await tick()
    expect(done).toBe(false)
    await p
  })

  it('★恢复会话失败要如实报错 —— 别让用户以为压过了', async () => {
    const f = fakeChild()
    const p = compactCodexThread('th-bad', { spawn: () => f.child })
    f.push({ id: f.writes[0].id, result: {} })
    await tick()
    const resume = f.writes.find(w => w.method === 'thread/resume')
    f.push({ id: resume.id, error: { message: 'thread not found' } })
    await expect(p).rejects.toThrow(/thread not found/)
  })

  it('★★子进程在压完之前退出 = 失败,不是成功', async () => {
    // 报「成功」会让用户以为压过了,而上下文一点没变 —— 这正是本项目最忌讳的那种假绿。
    const f = fakeChild()
    const p = compactCodexThread('th-1', { spawn: () => f.child })
    f.push({ id: f.writes[0].id, result: {} })
    await tick()
    f.close()
    await expect(p).rejects.toThrow(/退出/)
  })

  it('压缩请求本身被拒也要报错', async () => {
    const f = fakeChild()
    const p = compactCodexThread('th-1', { spawn: () => f.child })
    f.push({ id: f.writes[0].id, result: {} })
    await tick()
    const resume = f.writes.find(w => w.method === 'thread/resume')
    f.push({ id: resume.id, result: {} })
    await tick()
    const compact = f.writes.find(w => w.method === 'thread/compact/start')
    f.push({ id: compact.id, error: { message: 'compaction unavailable' } })
    await expect(p).rejects.toThrow(/compaction unavailable/)
  })

  it('超时要自己了断,不能永远挂着', async () => {
    const f = fakeChild()
    const p = compactCodexThread('th-1', { spawn: () => f.child, timeoutMs: 5 })
    await expect(p).rejects.toThrow(/超时/)
  })
})
