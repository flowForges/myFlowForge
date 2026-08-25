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
const join = (core: ReturnType<typeof createRelayCore>, s: RelaySocket, role: 'host' | 'client', room = ROOM) =>
  core.join(s, { t: 'join', role, room })

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
    join(core, c, 'client')
    expect(last(c)).toEqual({ t: 'relay', status: 'peer-online' })
    expect(last(h)).toEqual({ t: 'relay', status: 'peer-online' })
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
    join(core, c, 'client')
    core.relay(c, ROOM, 'client', 'ping')
    expect(h1.sent).toContain('ping')
    expect(h2.sent).not.toContain('ping')
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
    join(core, c1, 'client', ROOM)
    core.relay(c1, ROOM, 'client', 'only-for-h1')
    expect(h1.sent).toContain('only-for-h1')
    expect(h2.sent).not.toContain('only-for-h1')
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
    join(core, c, 'client')
    core.relay(c, ROOM, 'client', NASTY)
    expect(h.sent[h.sent.length - 1]).toBe(NASTY)
  })

  it('★★原样搬,一个字节都不改(host → client)', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    join(core, c, 'client')
    core.relay(h, ROOM, 'host', NASTY)
    expect(c.sent[c.sent.length - 1]).toBe(NASTY)
  })

  it('★空字符串也要照搬,不能当成「没东西」吞掉', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    join(core, c, 'client')
    const before = h.sent.length
    core.relay(c, ROOM, 'client', '')
    expect(h.sent.length).toBe(before + 1)
    expect(h.sent[h.sent.length - 1]).toBe('')
  })

  it('host 发的广播给所有客户端(手机和电脑可能同时连着)', () => {
    const core = createRelayCore()
    const h = sock()
    const a = sock()
    const b = sock()
    join(core, h, 'host')
    join(core, a, 'client')
    join(core, b, 'client')
    core.relay(h, ROOM, 'host', 'evt')
    expect(a.sent).toContain('evt')
    expect(b.sent).toContain('evt')
  })

  it('★★客户端之间绝不互相转发', () => {
    // 它们彼此没有会话密钥,转过去只是垃圾;更要紧的是那会让一个客户端能往另一个灌东西。
    const core = createRelayCore()
    const h = sock()
    const a = sock()
    const b = sock()
    join(core, h, 'host')
    join(core, a, 'client')
    join(core, b, 'client')
    core.relay(a, ROOM, 'client', 'from-a')
    expect(h.sent).toContain('from-a')
    expect(b.sent).not.toContain('from-a')
  })

  it('房间不存在时转发是空操作,不抛', () => {
    const core = createRelayCore()
    expect(() => core.relay(sock(), 'nosuchroomnosuchroomnosuch', 'client', 'x')).not.toThrow()
  })
})

describe('断开', () => {
  it('host 掉线,客户端被告知', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    join(core, c, 'client')
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
    join(core, a, 'client')
    join(core, b, 'client')
    const before = h.sent.length
    core.leave(a, ROOM, 'client')
    expect(h.sent.slice(before).map((x) => JSON.parse(x).status)).not.toContain('peer-offline')
    core.leave(b, ROOM, 'client')
    expect(last(h).status).toBe('peer-offline')
  })

  it('★不是当前 host 的连接来 leave,不能把真 host 摘掉', () => {
    const core = createRelayCore()
    const h1 = sock()
    const ghost = sock()
    join(core, h1, 'host')
    core.leave(ghost, ROOM, 'host')
    const c = sock()
    join(core, c, 'client')
    expect(last(c).status).toBe('peer-online')
  })

  it('★人走光了房间要回收 —— 否则公网中转跑几个月会攒一堆空壳', () => {
    const core = createRelayCore()
    const h = sock()
    const c = sock()
    join(core, h, 'host')
    join(core, c, 'client')
    expect(core.stats().rooms).toBe(1)
    core.leave(c, ROOM, 'client')
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
    core2.leave(extra, ROOM, 'client')
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
