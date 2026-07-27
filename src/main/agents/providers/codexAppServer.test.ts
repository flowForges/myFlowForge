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
    const h = driveCodexTurn(
      { cwd: '/ws', prompt: 'do it', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' },
      {
        onEvent: e => events.push(e),
        onApproval: async (req) => { approvalMethod = req.method; return 'allow' },
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
    f.push({ id: 99, method: 'item/commandExecution/requestApproval', params: { command: 'rm x' } })
    await new Promise(r => setTimeout(r, 0))
    expect(approvalMethod).toBe('item/commandExecution/requestApproval')
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
