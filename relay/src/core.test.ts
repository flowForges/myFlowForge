import { describe, it, expect } from 'vitest'
import {
  MAX_CLIENTS_PER_ROOM,
  createRelayCore,
  isValidRoom,
  parseJoin,
  type RelaySocket,
} from './core'

/** 一条假连接,把收到的东西记下来。 */
function sock(): RelaySocket & { sent: string[]; closed: boolean } {
  const s = {
    sent: [] as string[],
    closed: false,
    send(d: string) {
      s.sent.push(d)
    },
    close() {
      s.closed = true
    },
  }
  return s
}

const ROOM = 'kZ8vQ2mN4pR7sT1uW3xY5zA6bC8dE0fG'
const last = (s: { sent: string[] }) => (s.sent.length ? JSON.parse(s.sent[s.sent.length - 1]) : null)
/** join 并回「成不成」。cid 要另外拿的地方用 joinClient。 */
const join = (core: ReturnType<typeof createRelayCore>, s: RelaySocket, role: 'host' | 'client', room = ROOM) =>
  core.join(s, { t: 'join', role, room }).ok
/** join 一个客户端并把中转分配的 cid 拿出来。 */
const joinClient = (core: ReturnType<typeof createRelayCore>, s: RelaySocket, room = ROOM) => {
  const r = core.join(s, { t: 'join', role: 'client', room })
  if (!r.ok) throw new Error('join 被拒了')
  return r.cid!
}
/** host 要发给某个客户端时套的那层信封。 */
const env = (cid: string, d: string) => JSON.stringify({ t: 'data', cid, d })

describe('parseJoin —— 中转唯一会解析的东西', () => {
  it('好的 join 帧', () => {
    expect(parseJoin(JSON.stringify({ t: 'join', role: 'host', room: ROOM }))).toEqual({
      t: 'join',
      role: 'host',
      room: ROOM,
    })
  })

  it('★坏 JSON 返回 null,不抛 —— 面向公网的第一道门不能被一个畸形包打崩', () => {
    expect(parseJoin('{')).toBeNull()
    expect(parseJoin('')).toBeNull()
    expect(parseJoin('null')).toBeNull()
    expect(parseJoin('"a"')).toBeNull()
    expect(parseJoin('[]')).toBeNull()
  })

  it('角色只认 host / client', () => {
    expect(parseJoin(JSON.stringify({ t: 'join', role: 'admin', room: ROOM }))).toBeNull()
    expect(parseJoin(JSON.stringify({ t: 'join', room: ROOM }))).toBeNull()
  })

  it('不是 join 帧就不认', () => {
    expect(parseJoin(JSON.stringify({ t: 'req', role: 'host', room: ROOM }))).toBeNull()
  })

  it('★房间号必须卡死 —— 它来自网络,而且会被当 Map 的 key', () => {
    expect(isValidRoom(ROOM)).toBe(true)
    expect(isValidRoom('short')).toBe(false)
    expect(isValidRoom('x'.repeat(129))).toBe(false)
    expect(isValidRoom('../../etc/passwd')).toBe(false)
    expect(isValidRoom('房间')).toBe(false)
    expect(isValidRoom('__proto__')).toBe(false)
    expect(isValidRoom('')).toBe(false)
  })

  it('★原型链上的名字不能混进来当房间号', () => {
    expect(parseJoin(JSON.stringify({ t: 'join', role: 'host', room: '__proto__' }))).toBeNull()
    expect(parseJoin(JSON.stringify({ t: 'join', role: 'host', room: 'constructor' }))).toBeNull()
  })
})

describe('撮合', () => {
  it('host 先到:等着', () => {
    const core = createRelayCore()
    const h = sock()
    expect(join(core, h, 'host')).toBe(true)
    expect(last(h)).toEqual({ t: 'relay', status: 'waiting' })
  })

  it('client 后到:两边都收到对端上线', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    const cid = joinClient(core, c)
    expect(last(c)).toEqual({ t: 'relay', status: 'peer-online' })
    // ★host 那一侧**最后一帧是 open,不是状态帧** —— 加了 cid 之后它收到的是
    //  「对端上线」+「这条逻辑连接的编号是 N」两帧。断言要找那一帧,不能只看最后一帧,
    //  否则这条测试钉的其实是「两帧的先后顺序」,而那个顺序没有任何意义。
    expect(h.sent.map((x) => JSON.parse(x))).toContainEqual({ t: 'relay', status: 'peer-online' })
    expect(h.sent.map((x) => JSON.parse(x))).toContainEqual({ t: 'open', cid })
  })

  it('client 先到:等着,host 上线时被通知', () => {
    const core = createRelayCore()
    const c = sock()
    const h = sock()
    join(core, c, 'client')
    expect(last(c)).toEqual({ t: 'relay', status: 'waiting' })
    join(core, h, 'host')
    expect(last(c)).toEqual({ t: 'relay', status: 'peer-online' })
  })

  it('★★第二个 host 被拒,而不是把第一个踢下线', () => {
    // 房间号就是 daemon 的公钥,是公开的。换成「后来者顶掉前面的」,
    // 任何知道公钥的人都能反复连一下,把真 daemon 永久挤下线。
    const core = createRelayCore()
    const h1 = sock()
    const h2 = sock()
    expect(join(core, h1, 'host')).toBe(true)
    expect(join(core, h2, 'host')).toBe(false)
    expect(last(h2).status).toBe('error')
    // 第一个还好好地在
    const c = sock()
    const cid = joinClient(core, c)
    core.relay(c, ROOM, 'client', 'ping', cid)
    expect(h1.sent).toContain(JSON.stringify({ t: 'data', cid, d: 'ping' }))
    expect(h2.sent.some((x) => x.includes('ping'))).toBe(false)
  })

  it('客户端数有上限', () => {
    const core = createRelayCore()
    join(core, sock(), 'host')
    for (let i = 0; i < MAX_CLIENTS_PER_ROOM; i++) expect(join(core, sock(), 'client')).toBe(true)
    const extra = sock()
    expect(join(core, extra, 'client')).toBe(false)
    expect(last(extra).status).toBe('error')
  })

  it('不同房间互不相干', () => {
    const core = createRelayCore()
    const h1 = sock()
    const h2 = sock()
    const c1 = sock()
    const ROOM2 = 'AAAAbbbbCCCCddddEEEEffffGGGGhhhh'
    join(core, h1, 'host', ROOM)
    join(core, h2, 'host', ROOM2)
    const cid = joinClient(core, c1, ROOM)
    core.relay(c1, ROOM, 'client', 'only-for-h1', cid)
    expect(h1.sent.some((x) => x.includes('only-for-h1'))).toBe(true)
    expect(h2.sent.some((x) => x.includes('only-for-h1'))).toBe(false)
  })
})

describe('转发', () => {
  // ★这个 payload 是**故意难搬**的:首尾空白、换行、回车、制表、NUL、代理对、超长。
  //  中转做任何「顺手规范化」—— trim、换行转换、编码往返、截断 —— 都会当场被抓到。
  //  用一段干干净净的 base64 去测「原样搬」,等于没测:trim() 对它毫无影响。
  const NASTY = ' \r\n\t{"t":"enc","c":"AAAA//++=="}\u0000中🛡\r\n ' + 'x'.repeat(5000) + ' '

  it('★★原样搬,一个字节都不改(client → host)', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    const cid = joinClient(core, c)
    core.relay(c, ROOM, 'client', NASTY, cid)
    // ★信封是中转加的,`d` 必须原封不动 —— 这里就是那一条断言
    expect(JSON.parse(h.sent[h.sent.length - 1]).d).toBe(NASTY)
  })

  it('★★原样搬,一个字节都不改(host → client)', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    const cid = joinClient(core, c)
    core.relay(h, ROOM, 'host', env(cid, NASTY))
    // ★到客户端那一侧信封被拆掉,回到原样的字节 —— 客户端不知道中转存在
    expect(c.sent[c.sent.length - 1]).toBe(NASTY)
  })

  it('★空字符串也要照搬,不能当成「没东西」吞掉', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    const cid = joinClient(core, c)
    const before = h.sent.length
    core.relay(c, ROOM, 'client', '', cid)
    expect(h.sent.length).toBe(before + 1)
    expect(JSON.parse(h.sent[h.sent.length - 1]).d).toBe('')
  })

  it('★★host 点名回给某一个客户端,另一个收不到 —— 这就是加 cid 的全部理由', () => {
    // 这一层原来是广播。只有一个客户端时看起来是对的,多一个就**静默地**坏掉:
    // daemon 跟中转只有一条 socket,手机和笔记本的 hs-init 前后脚到达同一条流上,
    // daemon 无从分辨 —— 两把会话密钥串在一起,现象是「第二台设备连上就一直转圈」。
    const core = createRelayCore()
    const h = sock()
    const a = sock()
    const b = sock()
    join(core, h, 'host')
    const ca = joinClient(core, a)
    const cb = joinClient(core, b)
    expect(ca).not.toBe(cb)
    core.relay(h, ROOM, 'host', env(ca, 'only-a'))
    expect(a.sent).toContain('only-a')
    expect(b.sent).not.toContain('only-a')
  })

  it('★两个客户端各自发的,host 能分辨是谁发的', () => {
    const core = createRelayCore()
    const h = sock()
    const a = sock()
    const b = sock()
    join(core, h, 'host')
    const ca = joinClient(core, a)
    const cb = joinClient(core, b)
    core.relay(a, ROOM, 'client', 'from-a', ca)
    core.relay(b, ROOM, 'client', 'from-b', cb)
    const seen = h.sent.map((x) => JSON.parse(x)).filter((f) => f.t === 'data')
    expect(seen).toEqual([{ t: 'data', cid: ca, d: 'from-a' }, { t: 'data', cid: cb, d: 'from-b' }])
  })

  it('★客户端进来时 host 收到 open,走的时候收到 close —— 它靠这两条维护自己那侧的会话表', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    const cid = joinClient(core, c)
    expect(h.sent.map((x) => JSON.parse(x))).toContainEqual({ t: 'open', cid })
    core.leave(c, ROOM, 'client', cid)
    expect(h.sent.map((x) => JSON.parse(x))).toContainEqual({ t: 'close', cid })
  })

  it('★已经在等的客户端,要在 host 上线时逐个报到 —— 否则 host 手上没有它们的 cid', () => {
    const core = createRelayCore()
    const c = sock()
    const cid = joinClient(core, c)
    const h = sock()
    join(core, h, 'host')
    expect(h.sent.map((x) => JSON.parse(x))).toContainEqual({ t: 'open', cid })
  })

  it('★cid 只增不减 —— 复用编号会让一条刚断的连接的迟到数据落到新连接上', () => {
    const core = createRelayCore()
    join(core, sock(), 'host')
    const a = sock()
    const ca = joinClient(core, a)
    core.leave(a, ROOM, 'client', ca)
    const b = sock()
    expect(joinClient(core, b)).not.toBe(ca)
  })

  it('★host 的信封坏了只丢这一帧,不断 host —— 它驮着这个房间所有客户端', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    joinClient(core, c)
    const before = c.sent.length
    for (const bad of ['{', 'null', '{"t":"data"}', '{"t":"data","cid":"1"}', '{"t":"data","cid":"../x","d":"y"}', '{"t":"nope","cid":"1"}']) {
      expect(() => core.relay(h, ROOM, 'host', bad)).not.toThrow()
    }
    expect(h.closed).toBe(false)
    expect(c.sent.length).toBe(before)
  })

  it('★host 发给一个已经走了的 cid:静默丢。客户端刚断、响应还在路上是正常时序', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    const cid = joinClient(core, c)
    core.leave(c, ROOM, 'client', cid)
    expect(() => core.relay(h, ROOM, 'host', env(cid, 'late'))).not.toThrow()
    expect(h.closed).toBe(false)
  })

  it('host 可以主动关掉某一条逻辑连接', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    const cid = joinClient(core, c)
    core.relay(h, ROOM, 'host', JSON.stringify({ t: 'close', cid }))
    expect(c.closed).toBe(true)
  })

  it('★★客户端之间绝不互相转发', () => {
    // 它们彼此没有会话密钥,转过去只是垃圾;更要紧的是那会让一个客户端能往另一个灌东西。
    const core = createRelayCore()
    const h = sock()
    const a = sock()
    const b = sock()
    join(core, h, 'host')
    const ca = joinClient(core, a)
    joinClient(core, b)
    core.relay(a, ROOM, 'client', 'from-a', ca)
    expect(h.sent.some((x) => x.includes('from-a'))).toBe(true)
    expect(b.sent.some((x) => x.includes('from-a'))).toBe(false)
  })

  it('房间不存在时转发是空操作,不抛', () => {
    const core = createRelayCore()
    expect(() => core.relay(sock(), 'nosuchroomnosuchroomnosuch', 'client', 'x', '1')).not.toThrow()
  })
})

describe('断开', () => {
  it('host 掉线,客户端被告知', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    joinClient(core, c)
    core.leave(h, ROOM, 'host')
    expect(last(c)).toEqual({ t: 'relay', status: 'peer-offline' })
  })

  it('host 掉线后新的 host 可以接上(不是永久占位)', () => {
    const core = createRelayCore()
    const h1 = sock()
    join(core, h1, 'host')
    core.leave(h1, ROOM, 'host')
    expect(join(core, sock(), 'host')).toBe(true)
  })

  it('★★还剩客户端连着时,不能告诉 host「对端离线」', () => {
    // 报早了,daemon 会以为没人在看,进而停掉本该继续推的事件 —— 而手机还开着。
    const core = createRelayCore()
    const h = sock()
    const a = sock()
    const b = sock()
    join(core, h, 'host')
    const ca = joinClient(core, a)
    const cb = joinClient(core, b)
    const before = h.sent.length
    core.leave(a, ROOM, 'client', ca)
    expect(h.sent.slice(before).map((x) => JSON.parse(x).status)).not.toContain('peer-offline')
    core.leave(b, ROOM, 'client', cb)
    expect(last(h).status).toBe('peer-offline')
  })

  it('★不是当前 host 的连接来 leave,不能把真 host 摘掉', () => {
    const core = createRelayCore()
    const h1 = sock()
    const ghost = sock()
    join(core, h1, 'host')
    core.leave(ghost, ROOM, 'host')
    const c = sock()
    joinClient(core, c)
    expect(JSON.parse(c.sent[0]).status).toBe('peer-online')
  })

  it('★人走光了房间要回收 —— 否则公网中转跑几个月会攒一堆空壳', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    const cid = joinClient(core, c)
    expect(core.stats().rooms).toBe(1)
    core.leave(c, ROOM, 'client', cid)
    core.leave(h, ROOM, 'host')
    expect(core.stats().rooms).toBe(0)
  })

  it('被拒的连接不能留下空房间', () => {
    const core = createRelayCore()
    const h2 = sock()
    join(core, h2, 'host', 'BBBBccccDDDDeeeeFFFFggggHHHHiiii')
    core.leave(h2, 'BBBBccccDDDDeeeeFFFFggggHHHHiiii', 'host')
    expect(core.stats().rooms).toBe(0)
    // 客户端超限被拒时同理
    const core2 = createRelayCore()
    const extra = sock()
    core2.join(extra, { t: 'join', role: 'client', room: ROOM })
    core2.leave(extra, ROOM, 'client', '1')
    expect(core2.stats().rooms).toBe(0)
  })

  it('重复 leave 不抛', () => {
    const core = createRelayCore()
    const h = sock()
    join(core, h, 'host')
    core.leave(h, ROOM, 'host')
    expect(() => core.leave(h, ROOM, 'host')).not.toThrow()
  })
})

describe('restore · Durable Object 从 hibernation 醒来时重建房间', () => {
  const mk = () => {
    const sent: string[] = []
    const closed: number[] = []
    const sock: RelaySocket = { send: (d) => sent.push(d), close: (c) => closed.push(c ?? 0) }
    return { sock, sent, closed }
  }

  it('★重建不发任何帧 —— join 会发一串 peer-online,对面会看到一堆莫名其妙的状态', () => {
    const core = createRelayCore()
    const h = mk(); const c = mk()
    core.restore(h.sock, ROOM, 'host')
    core.restore(c.sock, ROOM, 'client', '7')
    expect(h.sent).toEqual([])
    expect(c.sent).toEqual([])
  })

  it('★重建之后转发照常走,而且用的是原来那个 cid', () => {
    const core = createRelayCore()
    const h = mk(); const c = mk()
    core.restore(h.sock, ROOM, 'host')
    core.restore(c.sock, ROOM, 'client', '7')
    core.relay(c.sock, ROOM, 'client', '密文', '7')
    expect(h.sent).toEqual([JSON.stringify({ t: 'data', cid: '7', d: '密文' })])
    core.relay(h.sock, ROOM, 'host', JSON.stringify({ t: 'data', cid: '7', d: '回来的密文' }))
    expect(c.sent).toEqual(['回来的密文'])
  })

  it('★★nextCid 要推到已恢复的 cid 之后 —— 否则新客户端拿到一个还在用的编号,两条连接串了', () => {
    const core = createRelayCore()
    const h = mk(); const old = mk(); const fresh = mk()
    core.restore(h.sock, ROOM, 'host')
    core.restore(old.sock, ROOM, 'client', '7')
    const r = core.join(fresh.sock, { t: 'join', role: 'client', room: ROOM })
    expect(r.ok).toBe(true)
    expect(r.ok && r.cid).toBe('8')
    // 发给新连接的帧不许落到老连接上
    core.relay(h.sock, ROOM, 'host', JSON.stringify({ t: 'data', cid: '8', d: '给新的' }))
    expect(fresh.sent.at(-1)).toBe('给新的')
    expect(old.sent).toEqual([])
  })

  it('★恢复期也只准一个 host —— 第二个不许把第一个顶掉', () => {
    const core = createRelayCore()
    const a = mk(); const b = mk(); const c = mk()
    core.restore(a.sock, ROOM, 'host')
    core.restore(b.sock, ROOM, 'host')
    core.restore(c.sock, ROOM, 'client', '1')
    core.relay(c.sock, ROOM, 'client', 'x', '1')
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toEqual([])
  })

  it('没有 cid 的客户端不恢复(那条连接已经没法投递了,留着只会占位)', () => {
    const core = createRelayCore()
    const c = mk()
    core.restore(c.sock, ROOM, 'client')
    expect(core.stats().connections).toBe(0)
  })

  it('房间号不合法一律不恢复 —— 它来自持久化的附件,同样是不可信输入', () => {
    const core = createRelayCore()
    const h = mk()
    core.restore(h.sock, '短', 'host')
    expect(core.stats()).toEqual({ rooms: 0, connections: 0 })
  })

  it('恢复之后 leave 照常清理', () => {
    const core = createRelayCore()
    const h = mk(); const c = mk()
    core.restore(h.sock, ROOM, 'host')
    core.restore(c.sock, ROOM, 'client', '3')
    core.leave(c.sock, ROOM, 'client', '3')
    expect(h.sent).toEqual([
      JSON.stringify({ t: 'close', cid: '3' }),
      JSON.stringify({ t: 'relay', status: 'peer-offline' }),
    ])
    core.leave(h.sock, ROOM, 'host')
    expect(core.stats()).toEqual({ rooms: 0, connections: 0 })
  })
})
