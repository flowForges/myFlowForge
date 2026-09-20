import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CH } from '../../../src/main/ipc/channels'
import { createDemoConn, DEMO_MAX_SESSIONS, DEMO_METHODS, DEMO_NEEDS_HOST, DEMO_WS_PATH } from './demoConn'

type Evt = { type?: string; id?: string; text?: string; tool?: { id: string; status: string }; message?: { text: string } }

/** 收集一轮里发出来的所有 chatEvent。 */
function collect(conn: ReturnType<typeof createDemoConn>) {
  const out: Evt[] = []
  conn.on(CH.chatEvent, (p) => out.push(p as Evt))
  return out
}

/** 这些频道里,哪些会撞到 `invoke` 的 default 分支(= 根本没实现)。 */
async function unimplemented(chans: Iterable<string>): Promise<string[]> {
  const conn = createDemoConn()
  const out: string[] = []
  for (const ch of chans) {
    try { await conn.invoke(ch, [{}]) } catch (e) {
      // 只有 default 分支那句算「没实现」。业务性拒绝(会话数上限之类)不算。
      if (/体验模式不支持这个操作/.test((e as Error).message)) out.push(ch)
    }
  }
  return out
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** 把假定时器推到底 —— 一轮里有 sleep 链,要反复 flush。 */
async function drain() {
  for (let i = 0; i < 400; i++) {
    await vi.advanceTimersByTimeAsync(50)
  }
}

describe('体验模式假连接', () => {
  it('★★事件序列和真链路一致:user → assistant-start → delta… → done', async () => {
    const conn = createDemoConn()
    const evts = collect(conn)
    const sid = conn.activeSessionId
    await conn.invoke(CH.chatSend, [{ sessionId: sid, text: '你好' }])
    await drain()
    const types = evts.map((e) => e.type)
    expect(types[0]).toBe('user')
    expect(types).toContain('assistant-start')
    expect(types).toContain('assistant-delta')
    expect(types[types.length - 1]).toBe('done')
    // 这正是「执行状态跟真实的一样」的判据:界面走的是同一条 useChat 分支。
  })

  it('★流式攒出来的正文和 done 落档那份一致 —— 对不上的话最后一刻会整段跳变', async () => {
    const conn = createDemoConn()
    const evts = collect(conn)
    await conn.invoke(CH.chatSend, [{ sessionId: conn.activeSessionId, text: '你好' }])
    await drain()
    const streamed = evts.filter((e) => e.type === 'assistant-delta').map((e) => e.text ?? '').join('')
    const done = evts.find((e) => e.type === 'done')
    expect(done?.message?.text).toBe(streamed)
  })

  it('★★工具卡先 run 后 ok,而且**同一个 id** —— 换 id 的话一次调用会画出两张卡', async () => {
    const conn = createDemoConn()
    const evts = collect(conn)
    await conn.invoke(CH.chatSend, [{ sessionId: conn.activeSessionId, text: '帮我跑一下测试' }])
    await drain()
    const tools = evts.filter((e) => e.type === 'tool-activity').map((e) => e.tool!)
    expect(tools.length).toBeGreaterThanOrEqual(4)          // 2 次调用 × 2 个阶段
    const byId = new Map<string, string[]>()
    for (const t of tools) byId.set(t.id, [...(byId.get(t.id) ?? []), t.status])
    for (const [id, phases] of byId) expect(phases, id).toEqual(['run', 'ok'])
  })

  it('停止能真的打断一轮', async () => {
    const conn = createDemoConn()
    const evts = collect(conn)
    await conn.invoke(CH.chatSend, [{ sessionId: conn.activeSessionId, text: '这是什么' }])
    await vi.advanceTimersByTimeAsync(500)   // 让它开始吐字
    await conn.invoke(CH.chatStop, [{}])
    await drain()
    const done = evts.find((e) => e.type === 'done')
    const streamed = evts.filter((e) => e.type === 'assistant-delta').map((e) => e.text ?? '').join('')
    // 打断之后仍然要收尾(done),否则界面永远卡在「忙」。
    expect(done).toBeTruthy()
    expect(done!.message!.text).toBe(streamed)
  })

  it('历史留得住', async () => {
    const conn = createDemoConn()
    const sid = conn.activeSessionId
    await conn.invoke(CH.chatSend, [{ sessionId: sid, text: '你好' }])
    await drain()
    const h = (await conn.invoke(CH.chatHistory, [{ sessionId: sid }])) as { messages: unknown[] }
    expect(h.messages).toHaveLength(2)
  })

  it(`★会话最多 ${DEMO_MAX_SESSIONS} 条,超了要**说清楚**而不是静默失败`, async () => {
    const conn = createDemoConn()
    for (let i = conn.sessionCount; i < DEMO_MAX_SESSIONS; i++) await conn.invoke(CH.sessionNew, [{}])
    expect(conn.sessionCount).toBe(DEMO_MAX_SESSIONS)
    await expect(conn.invoke(CH.sessionNew, [{}])).rejects.toThrow(/最多/)
  })

  it('★最后一条会话关不掉 —— 关光了这一屏就空了,而体验模式没有「再建一个」这条退路', async () => {
    const conn = createDemoConn()
    await conn.invoke(CH.sessionClose, [{ sessionId: conn.activeSessionId }])
    expect(conn.sessionCount).toBe(1)
  })

  it('★★新建工作区必须明确拒绝并说清原因 —— 假装成功之后人会进去找自己的代码', async () => {
    const conn = createDemoConn()
    await expect(conn.invoke(CH.workspaceCreate, [{}])).rejects.toThrow(DEMO_NEEDS_HOST)
  })

  it('★不认识的频道明确报错,不静默回 undefined', async () => {
    const conn = createDemoConn()
    await expect(conn.invoke('forge:nope', [])).rejects.toThrow(/体验模式/)
  })

  it('★「没有」和「坏了」是两回事:空数据回空值,不抛错', async () => {
    const conn = createDemoConn()
    await expect(conn.invoke(CH.chatGateState, [{}])).resolves.toEqual({ gates: [] })
    await expect(conn.invoke(CH.changesMulti, [{}])).resolves.toEqual({ repos: [] })
  })

  it('★★DEMO_METHODS 和 invoke 真正处理的频道必须一一对上', async () => {
    // 列多了 = 界面把按钮点亮,点下去撞 default 分支报错(比置灰更难理解);
    // 列少了 = 明明能用的功能被置灰,体验模式打开就是一屏灰按钮。两种都比没有更糟。
    const missing = await unimplemented(DEMO_METHODS)
    expect(missing).toEqual([])
    // ★反向自检:这条断言必须真的挂得住。塞一个不存在的频道进去,它得报出来 ——
    //  否则上面那个「通过」只是因为循环体什么也没验。
    expect(await unimplemented(new Set(['forge:definitely-not-a-channel']))).toEqual(['forge:definitely-not-a-channel'])
  })

  it('工作区列表里就一个体验工作区', async () => {
    const conn = createDemoConn()
    const ws = (await conn.invoke(CH.workspacesList)) as { path: string }[]
    expect(ws).toHaveLength(1)
    expect(ws[0].path).toBe(DEMO_WS_PATH)
  })

  it('★第一条消息之后会话标题变成问题本身,列表上才认得出哪条是哪条', async () => {
    const conn = createDemoConn()
    await conn.invoke(CH.chatSend, [{ sessionId: conn.activeSessionId, text: '权限门是什么' }])
    await drain()
    const f = (await conn.invoke(CH.sessionList, [DEMO_WS_PATH])) as { sessions: { title: string }[] }
    expect(f.sessions[0].title).toBe('权限门是什么')
  })
})
