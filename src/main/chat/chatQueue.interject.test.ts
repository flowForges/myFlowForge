import { describe, it, expect, vi } from 'vitest'
import { ChatQueue } from './chatQueue'
import type { ChatSendPayload } from '@shared/types'

const mkS = (sid: string, text: string, extra: Partial<ChatSendPayload> = {}): ChatSendPayload =>
  ({ workspacePath: '/w', sessionId: sid, agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text, attachments: [], ...extra })
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

/** 一条泳道:第一条消息起一轮(不收尾,手动 release),其余排队。 */
function setup() {
  const sent: string[] = []
  const releases: Array<() => void> = []
  const events: any[] = []
  const q = new ChatQueue(vi.fn((p: ChatSendPayload) => { sent.push(`${p.sessionId}:${p.text}`); return new Promise<void>(res => { releases.push(res) }) }), (_c, e) => events.push(e))
  return { q, sent, releases, events, last: () => events[events.length - 1] }
}

describe('ChatQueue.take / putBack', () => {
  it('take 取走一条并给出原位置;再 take 同一条是 null', () => {
    const { q } = setup()
    q.enqueue(mkS('s1', 'A'), '你')
    q.enqueue(mkS('s1', 'B'), '你')
    q.enqueue(mkS('s1', 'C'), '你')
    const [b, c] = q.snapshot('/w').queue
    const got = q.take('/w', 's1', c.id)
    expect(got?.payload.text).toBe('C')
    expect(got?.index).toBe(1)
    expect(q.take('/w', 's1', c.id)).toBeNull()
    expect(q.snapshot('/w').queue.map(x => x.id)).toEqual([b.id])
  })

  it('会话隔离:B 会话拿不到 A 会话排着的那条', () => {
    const { q } = setup()
    q.enqueue(mkS('a', 'A1'), '你')
    q.enqueue(mkS('a', 'A2'), '你')
    const id = q.snapshot('/w').queue[0].id
    expect(q.take('/w', 'b', id)).toBeNull()
    expect(q.take('/w', 'a', id)?.payload.text).toBe('A2')
  })

  it('take 和撤回竞争:只有一个成功', () => {
    const { q } = setup()
    q.enqueue(mkS('s1', 'A'), '你')
    q.enqueue(mkS('s1', 'B'), '你')
    q.enqueue(mkS('s1', 'C'), '你')
    const [b, c] = q.snapshot('/w').queue
    expect(q.take('/w', 's1', b.id)).not.toBeNull()
    expect(q.cancel('/w', b.id)).toBe(false)
    expect(q.cancel('/w', c.id)).toBe(true)
    expect(q.take('/w', 's1', c.id)).toBeNull()
  })

  it('putBack 放回原位置;泳道已空闲时立刻发出', async () => {
    const { q, sent, releases } = setup()
    q.enqueue(mkS('s1', 'A'), '你')
    q.enqueue(mkS('s1', 'B'), '你')
    q.enqueue(mkS('s1', 'C'), '你')
    const b = q.take('/w', 's1', q.snapshot('/w').queue[0].id)!
    q.putBack('/w', 's1', b, b.index)
    expect(q.snapshot('/w').queue.map(x => x.text)).toEqual(['B', 'C'])
    releases[0](); await flush()
    expect(sent).toEqual(['s1:A', 's1:B'])
    // 取走后这一轮结束、下一条已经开跑:放回去的那条排在剩下的最前面,不丢
    const c = q.take('/w', 's1', q.snapshot('/w').queue[0].id)!
    releases[1](); await flush()
    expect(sent).toEqual(['s1:A', 's1:B'])           // 空闲了,队列里没东西
    q.putBack('/w', 's1', c, c.index)
    await flush()
    expect(sent).toEqual(['s1:A', 's1:B', 's1:C'])
  })
})

describe('ChatQueue.interject', () => {
  it('成功:这条离开队列,下一轮不再发送它', async () => {
    const { q, sent, releases } = setup()
    q.enqueue(mkS('s1', 'A'), '你')
    q.enqueue(mkS('s1', 'B', { attachments: [{ name: 'f', path: '/f', size: 1 }], via: 'iPhone' }), '你')
    q.enqueue(mkS('s1', 'C'), '你')
    const inj = vi.fn(async () => true)
    q.registerActive('/w', 's1', () => {}, inj)
    const id = q.snapshot('/w').queue[0].id
    expect(await q.interject('/w', 's1', id)).toEqual({ ok: true })
    expect(inj).toHaveBeenCalledWith('B', [{ name: 'f', path: '/f', size: 1 }], 'iPhone')
    expect(q.snapshot('/w').queue.map(x => x.text)).toEqual(['C'])
    releases[0](); await flush()
    releases[1](); await flush()
    expect(sent).toEqual(['s1:A', 's1:C'])
  })

  it('provider 说不行(这一轮刚好结束):放回原位置,下一轮照常发,不丢', async () => {
    const { q, sent, releases } = setup()
    q.enqueue(mkS('s1', 'A'), '你')
    q.enqueue(mkS('s1', 'B'), '你')
    q.enqueue(mkS('s1', 'C'), '你')
    q.registerActive('/w', 's1', () => {}, async () => false)
    const id = q.snapshot('/w').queue[0].id
    expect(await q.interject('/w', 's1', id)).toEqual({ ok: false, code: 'not_running' })
    expect(q.snapshot('/w').queue.map(x => x.text)).toEqual(['B', 'C'])
    releases[0](); await flush()
    expect(sent).toEqual(['s1:A', 's1:B'])
  })

  it('等 provider 回话期间这一轮结束了、provider 说不行:放回去后照样发出(只发一次)', async () => {
    const { q, sent, releases } = setup()
    q.enqueue(mkS('s1', 'A'), '你')
    q.enqueue(mkS('s1', 'B'), '你')
    let answer: (ok: boolean) => void = () => {}
    q.registerActive('/w', 's1', () => {}, () => new Promise<boolean>(r => { answer = r }))
    const p = q.interject('/w', 's1', q.snapshot('/w').queue[0].id)
    releases[0](); await flush()
    expect(sent).toEqual(['s1:A'])                    // 它不在队列里:不会被这次调度发出去
    answer(false)
    expect(await p).toEqual({ ok: false, code: 'not_running' })
    await flush()
    expect(sent).toEqual(['s1:A', 's1:B'])
  })

  it('同一条连点两次:provider 只被调一次', async () => {
    const { q } = setup()
    q.enqueue(mkS('s1', 'A'), '你')
    q.enqueue(mkS('s1', 'B'), '你')
    const inj = vi.fn(async () => true)
    q.registerActive('/w', 's1', () => {}, inj)
    const id = q.snapshot('/w').queue[0].id
    const [r1, r2] = await Promise.all([q.interject('/w', 's1', id), q.interject('/w', 's1', id)])
    expect([r1, r2]).toEqual([{ ok: true }, { ok: false, code: 'gone' }])
    expect(inj).toHaveBeenCalledOnce()
  })

  it('撤回先到:插话什么都不做', async () => {
    const { q } = setup()
    q.enqueue(mkS('s1', 'A'), '你')
    q.enqueue(mkS('s1', 'B'), '你')
    const inj = vi.fn(async () => true)
    q.registerActive('/w', 's1', () => {}, inj)
    const id = q.snapshot('/w').queue[0].id
    expect(q.cancel('/w', id)).toBe(true)
    expect(await q.interject('/w', 's1', id)).toEqual({ ok: false, code: 'gone' })
    expect(inj).not.toHaveBeenCalled()
  })

  it('没有在跑的一轮 / provider 不支持 → 不动队列', async () => {
    const { q } = setup()
    q.enqueue(mkS('s1', 'A'), '你')
    q.enqueue(mkS('s1', 'B'), '你')
    const id = q.snapshot('/w').queue[0].id
    expect(await q.interject('/w', 's1', id)).toEqual({ ok: false, code: 'unsupported' })
    expect(q.snapshot('/w').queue.map(x => x.text)).toEqual(['B'])
    q.cancel('/w', id)
    q.enqueue(mkS('s9', 'X'), '你')      // s9 空闲:直接跑了,队列里没有
    expect(await q.interject('/w', 's9', 'q-nope')).toEqual({ ok: false, code: 'gone' })
  })

  it('A/B 两会话:A 的插话只进 A 那一轮', async () => {
    const { q } = setup()
    q.enqueue(mkS('a', 'A1'), '你')
    q.enqueue(mkS('b', 'B1'), '你')
    q.enqueue(mkS('a', 'A2'), '你')
    const injA = vi.fn(async () => true), injB = vi.fn(async () => true)
    q.registerActive('/w', 'a', () => {}, injA)
    q.registerActive('/w', 'b', () => {}, injB)
    const id = q.snapshot('/w').queue[0].id
    expect(await q.interject('/w', 'b', id)).toEqual({ ok: false, code: 'gone' })
    expect(await q.interject('/w', 'a', id)).toEqual({ ok: true })
    expect(injA).toHaveBeenCalledOnce()
    expect(injB).not.toHaveBeenCalled()
  })

  it('队列事件逐项带 interjectable:只有该会话在跑且 provider 能插话', async () => {
    const { q, releases, last } = setup()
    q.enqueue(mkS('a', 'A1'), '你')
    q.enqueue(mkS('a', 'A2'), '你')
    expect(last().queue[0].interjectable).toBe(false)
    q.registerActive('/w', 'a', () => {}, async () => true)
    expect(last().queue[0].interjectable).toBe(true)
    q.registerActive('/w', 'a', () => {})            // 子代理接管停止键:没有插话能力
    expect(last().queue[0].interjectable).toBe(false)
    q.registerActive('/w', 'a', () => {}, async () => true)
    releases[0](); await flush()                       // A1 收尾,A2 开跑:新的一轮还没登记能力
    expect(q.snapshot('/w').queue).toEqual([])
    q.enqueue(mkS('a', 'A3'), '你')
    expect(last().queue[0].interjectable).toBe(false)
  })
})

describe('ChatQueue.interject · 只能插进同一个 provider 的那一轮', () => {
  it('排给 codex 的那条不能插进正在跑的 claude 一轮:interjectable=false,interject → unsupported,仍在队列里', async () => {
    const { q, last } = setup()
    const inj = vi.fn(async () => true)
    q.enqueue(mkS('s1', 'A'), '你')                              // claude 在跑
    q.enqueue(mkS('s1', 'B', { agent: 'codex', agentLabel: 'Codex' }), '你')
    q.enqueue(mkS('s1', 'C'), '你')
    q.registerActive('/w', 's1', () => {}, inj)
    const [b, c] = last().queue
    expect(b.interjectable).toBe(false)
    expect(c.interjectable).toBe(true)
    expect(await q.interject('/w', 's1', b.id)).toEqual({ ok: false, code: 'unsupported' })
    expect(inj).not.toHaveBeenCalled()
    expect(q.snapshot('/w').queue.map(x => x.text)).toEqual(['B', 'C'])
    expect(await q.interject('/w', 's1', c.id)).toEqual({ ok: true })
  })
})
