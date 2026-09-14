import { describe, it, expect } from 'vitest'
import { driveCodexTurn, type CodexChild } from './codexAppServer'

// A scriptable fake app-server: capture writes, let the test push stdout lines.
function fakeChild() {
  let onData: ((c: Buffer) => void) | undefined
  let onClose: ((a?: unknown) => void) | undefined
  const writes: any[] = []
  let killed = 0
  const child: CodexChild = {
    stdin: { write: (s: string) => { for (const ln of s.split('\n')) if (ln.trim()) writes.push(JSON.parse(ln)) } },
    stdout: { on: (_e, cb) => { onData = cb } },
    stderr: { on: () => {} },
    on: (e, cb) => { if (e === 'close') onClose = cb },
    kill: () => { killed++ },
  }
  const push = (o: any) => onData?.(Buffer.from(JSON.stringify(o) + '\n'))
  return { child, writes, push, close: () => onClose?.(), get killed() { return killed } }
}

describe('driveCodexTurn', () => {
  it('handshakes, starts a turn, routes an approval, and streams adapted events', async () => {
    const f = fakeChild()
    const events: any[] = []
    let approvalMethod = ''
    let approvalItemId: string | undefined
    const h = driveCodexTurn(
      { cwd: '/ws', prompt: 'do it', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' },
      {
        onEvent: e => events.push(e),
        onApproval: async (req) => { approvalMethod = req.method; approvalItemId = req.itemId; return 'allow' },
        onSession: () => {}, onError: () => {},
      },
      { spawn: () => f.child },
    )
    // initialize was sent first
    expect(f.writes[0].method).toBe('initialize')
    f.push({ id: f.writes[0].id, result: {} })                 // init ok
    // → initialized + thread/start
    expect(f.writes.some(w => w.method === 'initialized')).toBe(true)
    const start = f.writes.find(w => w.method === 'thread/start')
    expect(start.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only', cwd: '/ws' })
    f.push({ id: start.id, result: { thread: { id: 'th1' } } })  // thread started
    const turn = f.writes.find(w => w.method === 'turn/start')
    expect(turn.params).toMatchObject({ threadId: 'th1', input: [{ type: 'text', text: 'do it' }] })
    // server asks for approval
    f.push({ id: 99, method: 'item/commandExecution/requestApproval', params: { itemId: 'item_5', command: 'rm x' } })
    await new Promise(r => setTimeout(r, 0))
    expect(approvalMethod).toBe('item/commandExecution/requestApproval')
    // ★★itemId 要一路透出去:它是这次调用的工具卡行 id,上层靠它把「自动放行」挂到那张卡上。
    //   丢了它,自动放行就只能退化成往对话流里插一条带着原样命令的假「系统回答」。
    expect(approvalItemId).toBe('item_5')
    const resp = f.writes.find(w => w.id === 99)
    expect(resp.result).toEqual({ decision: 'accept' })
    // a streamed assistant delta becomes an adapted event
    f.push({ method: 'item/agentMessage/delta', params: { delta: 'hi' } })
    expect(events.at(-1)).toEqual({ msg: { type: 'agent_message_delta', delta: 'hi' } })
    // turn completes
    f.push({ method: 'turn/completed', params: {} })
    await expect(h.done).resolves.toEqual({ ok: true })
  })

  it('kills the child process once the turn settles (turn/completed)', async () => {
    // codex app-server is a persistent process; a completed turn must kill it
    // (a fresh child is spawned per turn, threaded via resumeThreadId) so it
    // never leaks a live process + open stdio pipes.
    const f = fakeChild()
    const h = driveCodexTurn(
      { cwd: '/ws', prompt: 'do it', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' },
      { onEvent: () => {}, onApproval: async () => 'allow', onSession: () => {}, onError: () => {} },
      { spawn: () => f.child },
    )
    f.push({ id: f.writes[0].id, result: {} })
    const start = f.writes.find(w => w.method === 'thread/start')
    f.push({ id: start.id, result: { thread: { id: 'th2' } } })
    expect(f.killed).toBe(0)
    f.push({ method: 'turn/completed', params: {} })
    await expect(h.done).resolves.toEqual({ ok: true })
    expect(f.killed).toBe(1)
  })

  it('denies an approval and surfaces a systemError', async () => {
    const f = fakeChild()
    let err = ''
    const h = driveCodexTurn(
      { cwd: '/ws', prompt: 'x', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' },
      { onEvent: () => {}, onApproval: async () => 'deny', onSession: () => {}, onError: m => { err = m } },
      { spawn: () => f.child },
    )
    f.push({ id: f.writes[0].id, result: {} })
    const start = f.writes.find(w => w.method === 'thread/start')
    f.push({ id: start.id, result: { thread: { id: 't' } } })
    f.push({ id: 7, method: 'item/fileChange/requestApproval', params: { paths: ['a'] } })
    await new Promise(r => setTimeout(r, 0))
    expect(f.writes.find(w => w.id === 7).result).toEqual({ decision: 'decline' })
    f.push({ method: 'error', params: { error: { message: '400 bad model' } } })
    await expect(h.done).resolves.toEqual({ ok: false })
    expect(err).toContain('400')
  })

  it('fails closed (decline) when onApproval rejects, instead of hanging done', async () => {
    const f = fakeChild()
    const h = driveCodexTurn(
      { cwd: '/ws', prompt: 'x', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' },
      {
        onEvent: () => {},
        onApproval: async () => { throw new Error('confirm gate torn down') },
        onSession: () => {}, onError: () => {},
      },
      { spawn: () => f.child },
    )
    f.push({ id: f.writes[0].id, result: {} })
    const start = f.writes.find(w => w.method === 'thread/start')
    f.push({ id: start.id, result: { thread: { id: 't' } } })
    f.push({ id: 42, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf x' } })
    await new Promise(r => setTimeout(r, 0))
    // The server was blocked awaiting this response; a rejected onApproval must
    // still answer it (fail-closed decline) rather than leaving `done` hung.
    const resp = f.writes.find(w => w.id === 42)
    expect(resp).toBeDefined()
    expect(resp.result).toEqual({ decision: 'decline' })
    // done doesn't hang forever: the declined turn still flows to completion.
    f.push({ method: 'turn/completed', params: {} })
    await expect(h.done).resolves.toEqual({ ok: true })
  })

  it('does not write to the killed child when a late-resolving approval settles after cancel()', async () => {
    // cancel() settles+kills the child. A pending onApproval that resolves
    // afterwards must not call respond() (which would write to dead stdin).
    const f = fakeChild()
    let resolveApproval!: (v: 'allow' | 'deny') => void
    const pending = new Promise<'allow' | 'deny'>(r => { resolveApproval = r })
    const h = driveCodexTurn(
      { cwd: '/ws', prompt: 'x', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' },
      { onEvent: () => {}, onApproval: async () => pending, onSession: () => {}, onError: () => {} },
      { spawn: () => f.child },
    )
    f.push({ id: f.writes[0].id, result: {} })
    const start = f.writes.find(w => w.method === 'thread/start')
    f.push({ id: start.id, result: { thread: { id: 't' } } })
    f.push({ id: 55, method: 'item/commandExecution/requestApproval', params: { command: 'rm x' } })
    await new Promise(r => setTimeout(r, 0))
    expect(f.writes.find(w => w.id === 55)).toBeUndefined() // still pending, no response yet

    h.cancel() // settles + kills the child
    await expect(h.done).resolves.toEqual({ ok: false })
    const writeCountAfterCancel = f.writes.length

    resolveApproval('allow') // late-resolving approval fires after settle
    await new Promise(r => setTimeout(r, 0))

    // respond() is a no-op post-settle: no new write appears, and specifically
    // no decision response is written for the pending approval id.
    expect(f.writes.length).toBe(writeCountAfterCancel)
    expect(f.writes.find(w => w.id === 55 && w.result?.decision)).toBeUndefined()
  })

  it('send() after settle is a no-op: cancel() called post-completion does not fire onError', async () => {
    // Regression for FIX #6: cancel()'s `turn/interrupt` send used to call cb.onError
    // unconditionally on a write failure. A cancel() that arrives after the turn already
    // settled (turn/completed) + killed the child writes to now-dead stdin — that must be a
    // silent no-op (via safeError, which checks `settled`), not a spurious post-completion error.
    const f = fakeChild()
    let deadStdin = false
    f.child.stdin.write = (s: string) => {
      if (deadStdin) throw new Error('write EPIPE')
      for (const ln of s.split('\n')) if (ln.trim()) f.writes.push(JSON.parse(ln))
    }
    let err = ''
    const h = driveCodexTurn(
      { cwd: '/ws', prompt: 'x', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' },
      { onEvent: () => {}, onApproval: async () => 'allow', onSession: () => {}, onError: m => { err = m } },
      { spawn: () => f.child },
    )
    f.push({ id: f.writes[0].id, result: {} })
    const start = f.writes.find(w => w.method === 'thread/start')
    f.push({ id: start.id, result: { thread: { id: 't' } } })
    f.push({ method: 'turn/completed', params: {} })
    await expect(h.done).resolves.toEqual({ ok: true })   // settled + child killed
    deadStdin = true                                       // simulate the now-dead stdin post-kill

    h.cancel()   // a late cancel() still sends turn/interrupt — must not surface an error
    await new Promise(r => setTimeout(r, 0))

    expect(err).toBe('')
  })

  it('falls back to opts.resumeThreadId when thread/resume omits the thread id', async () => {
    const f = fakeChild()
    driveCodexTurn(
      { cwd: '/ws', prompt: 'continue', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request', resumeThreadId: 'th-old' },
      { onEvent: () => {}, onApproval: async () => 'allow', onSession: () => {}, onError: () => {} },
      { spawn: () => f.child },
    )
    f.push({ id: f.writes[0].id, result: {} })
    const resume = f.writes.find(w => w.method === 'thread/resume')
    expect(resume.params).toMatchObject({ threadId: 'th-old' })
    // result omits both thread.id and threadId
    f.push({ id: resume.id, result: {} })
    const turn = f.writes.find(w => w.method === 'turn/start')
    expect(turn.params).toMatchObject({ threadId: 'th-old', input: [{ type: 'text', text: 'continue' }] })
  })
})

/**
 * 用户 2026-09-14:codex(逐字输出 = app-server 通路)跑公司内部 MCP,里面有 python,MCP 要问权限。
 * 「咱们 app 没有弹窗,光标一直在动,但是没有内容输出」。
 *
 * ★★根因不是没收到,是**回答形状错了**。codex 官方 schema 给每种服务端请求规定了不同的回答,
 *  而这里原来:审批一律回 `{decision}`、其余一律回 `{}`。回答缺必填字段不会报错 ——
 *  codex 反序列化失败,那次调用**永远悬着**,这一轮永不结束,于是光标一直在动而什么都没有。
 */
describe('服务端请求:每一种都要回对形状,并且绝不能静默', () => {
  // 把握手 + 起一轮跑完,返回可继续推消息的句柄。
  const started = (cbs: Partial<Parameters<typeof driveCodexTurn>[1]> = {}) => {
    const f = fakeChild()
    const notices: string[] = []
    driveCodexTurn(
      { cwd: '/ws', prompt: 'go', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' },
      {
        onEvent: () => {}, onSession: () => {}, onError: () => {},
        onApproval: async () => 'allow',
        onNotice: (t) => notices.push(t),
        ...cbs,
      },
      { spawn: () => f.child },
    )
    f.push({ id: f.writes[0].id, result: {} })
    const start = f.writes.find((w: any) => w.method === 'thread/start')
    f.push({ id: start.id, result: { thread: { id: 'th1' } } })
    return { f, notices }
  }

  it('★★权限申请:回的是 {permissions},不是 {decision} —— 回错就是那个「一直转」的成因', async () => {
    const { f } = started({ onApproval: async () => 'allow' })
    const asked = { network: { enabled: true } }
    f.push({ id: 77, method: 'item/permissions/requestApproval', params: { itemId: 'i1', permissions: asked, reason: '装依赖要联网' } })
    await new Promise(r => setTimeout(r, 0))
    expect(f.writes.find((w: any) => w.id === 77).result).toEqual({ permissions: asked, scope: 'turn' })
  })

  it('拒绝权限 = 给一个空档(permissions 是必填的,不能省)', async () => {
    const { f } = started({ onApproval: async () => 'deny' })
    f.push({ id: 78, method: 'item/permissions/requestApproval', params: { itemId: 'i1', permissions: { network: { enabled: true } } } })
    await new Promise(r => setTimeout(r, 0))
    expect(f.writes.find((w: any) => w.id === 78).result).toEqual({ permissions: {}, scope: 'turn' })
  })

  it('★★MCP elicitation 现在会走确认门,而且带着是哪个 MCP 在问', async () => {
    let seen: any = null
    const { f } = started({ onApproval: async (r) => { seen = r; return 'allow' } })
    f.push({ id: 79, method: 'mcpServer/elicitation/request', params: { serverName: 'inner-mcp', threadId: 'th1', mode: 'form', message: '允许执行 python?', requestedSchema: { type: 'object', properties: {} } } })
    await new Promise(r => setTimeout(r, 0))
    expect(seen.serverName).toBe('inner-mcp')
    expect(seen.message).toBe('允许执行 python?')
    expect(f.writes.find((w: any) => w.id === 79).result).toEqual({ action: 'accept' })
  })

  it('★要填表单的 elicitation:答不了也必须**当场回复**并说一句人话,不许悬着', async () => {
    let asked = false
    const { f, notices } = started({ onApproval: async () => { asked = true; return 'allow' } })
    f.push({ id: 80, method: 'mcpServer/elicitation/request', params: { serverName: 'inner-mcp', threadId: 'th1', mode: 'form', message: '填个 token', requestedSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } } })
    await new Promise(r => setTimeout(r, 0))
    expect(asked).toBe(false)                                  // 别拿一道答不了的门去烦用户
    expect(f.writes.find((w: any) => w.id === 80).result).toEqual({ action: 'decline' })
    expect(notices.join()).toContain('token')                  // 但要说清缺什么
  })

  it('★★不认识的请求:回 JSON-RPC 错误 + 说一句话,而不是以前那个静默的 {}', async () => {
    const { f, notices } = started()
    f.push({ id: 81, method: 'some/futureThing', params: {} })
    await new Promise(r => setTimeout(r, 0))
    const r = f.writes.find((w: any) => w.id === 81)
    expect(r.result).toBeUndefined()
    expect(r.error.code).toBe(-32601)
    expect(notices.join()).toContain('some/futureThing')
  })

  it('requestUserInput:按 schema 回一个空答卷(answers 必填),让这一轮能继续', async () => {
    const { f, notices } = started()
    f.push({ id: 82, method: 'requestUserInput', params: { isBlocking: true, itemId: 'i9', questions: [] } })
    await new Promise(r => setTimeout(r, 0))
    expect(f.writes.find((w: any) => w.id === 82).result).toEqual({ answers: {} })
    expect(notices.length).toBe(1)
  })
})
