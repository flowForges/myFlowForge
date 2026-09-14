import { spawnAgent } from '../procGroup'

/**
 * 手动压缩一条 codex 会话的上下文。
 *
 * ★★为什么要**另起一个** app-server:我们的 `driveCodexTurn` 是「一轮一个进程」,一轮跑完就把子进程
 *  杀了(见 codexAppServer 的 settle())。所以用户点「压缩」的那一刻,根本没有活着的 app-server 可用。
 *  好在 thread 是**落在磁盘上的**(~/.codex/sessions 的 rollout 文件),`thread/resume` 能把它捞回来,
 *  `thread/compact/start` 只要一个 threadId —— 这正是 codex CLI 自己执行 `/compact` 时做的事。
 *
 * ★协议来源:`codex app-server generate-json-schema`。`ThreadCompactStartParams` 的必填字段
 *  只有 `threadId`。压缩完成的信号是 `thread/compacted` 通知(我们的事件适配器早就认识它)。
 *
 * 框架照搬 usage/codexRpc.ts 那套一次性 RPC:initialize → initialized → 请求 → 收到就收工。
 */

export interface CompactChild {
  stdin: { write(s: string): void }
  stdout: { on(ev: 'data', cb: (c: Buffer) => void): void }
  stderr: { on(ev: 'data', cb: (c: Buffer) => void): void }
  on(ev: 'error' | 'close', cb: (arg?: unknown) => void): void
  kill(): void
}

export interface CompactDeps {
  spawn?: (cmd: string, args: string[]) => CompactChild
  timeoutMs?: number
}

export function compactCodexThread(threadId: string, deps: CompactDeps = {}): Promise<void> {
  // ★ 同 codexAppServer / codexRpc:Windows 上 codex 是 `codex.cmd`,node 原生 spawn 拿裸名会 ENOENT。
  const spawn = deps.spawn ?? ((cmd, args) => spawnAgent(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, reject: false }) as unknown as CompactChild)
  // 压缩要让模型把整段历史重写一遍,比普通 RPC 慢得多 —— 给足时间,别在人家干到一半时掐掉。
  const timeoutMs = deps.timeoutMs ?? 180_000

  return new Promise<void>((resolve, reject) => {
    const child = spawn('codex', ['app-server'])
    let buffer = ''
    let settled = false
    let rpcId = 0
    let resumeId: number | null = null
    let compactId: number | null = null

    const timer = setTimeout(() => fail(new Error('压缩超时:codex 没有在 3 分钟内完成')), timeoutMs)
    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* 已经没了 */ }
      fn()
    }
    const fail = (e: Error) => settle(() => reject(e))
    const ok = () => settle(() => resolve())

    function send(method: string, params?: unknown, id?: number): void {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params: params ?? {} })}\n`)
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    }

    const initId = ++rpcId
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg: any
        try { msg = JSON.parse(line) } catch { continue }   // 启动横幅之类的非 JSON 噪音

        // ★压缩完成的权威信号。它是个**通知**,不是 compact 请求的回包 —— 回包可能先到(表示
        //  「已受理」),真正压完要等这一条。
        if (msg.method === 'thread/compacted') { ok(); return }

        if (msg.id === initId) {
          if (msg.error) return fail(new Error(msg.error.message ?? 'codex initialize 失败'))
          send('initialized')
          resumeId = ++rpcId
          send('thread/resume', { threadId }, resumeId)
          continue
        }
        if (resumeId !== null && msg.id === resumeId) {
          if (msg.error) return fail(new Error(msg.error.message ?? `恢复会话失败(${threadId})`))
          compactId = ++rpcId
          send('thread/compact/start', { threadId }, compactId)
          continue
        }
        if (compactId !== null && msg.id === compactId && msg.error) {
          return fail(new Error(msg.error.message ?? '压缩请求被拒绝'))
        }
      }
    })
    child.stderr.on('data', () => {})    // 排空,否则管道满了会把子进程堵死
    child.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))))
    // ★子进程先退出 = 没等到 thread/compacted 就没了。这必须算失败 —— 报「成功」会让用户以为
    //  压过了,而上下文一点没变。
    child.on('close', () => fail(new Error('codex 在压缩完成前退出了')))

    send('initialize', { clientInfo: { name: 'myFlowForge', version: '1.0.0' } }, initId)
  })
}
