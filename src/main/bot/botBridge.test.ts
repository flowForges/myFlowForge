import { describe, it, expect } from 'vitest'
import { BotBridge, parseCommand, genPairing } from './botBridge'
import { IdRegistry } from './idRegistry'
import { defaultBotConfig } from './botTypes'
import type {
  BotTransport, InboundBotMessage, OutboundBotMessage, BotAddress, BotBridgeConfig,
} from './botTypes'

class FakeTransport implements BotTransport {
  readonly platform = 'dingtalk' as const
  sent: { to: BotAddress; msg: OutboundBotMessage }[] = []
  private msgCb?: (m: InboundBotMessage) => void
  private statusCb?: (s: import('./botTypes').BotStatus) => void
  onMessage(cb: (m: InboundBotMessage) => void) { this.msgCb = cb }
  onStatus(cb: (s: import('./botTypes').BotStatus) => void) { this.statusCb = cb }
  async start() { this.statusCb?.({ state: 'online' }) }
  async stop() { this.statusCb?.({ state: 'offline' }) }
  async send(to: BotAddress, msg: OutboundBotMessage) { this.sent.push({ to, msg }) }
  lastText(): string {
    const m = this.sent[this.sent.length - 1]?.msg
    return m ? (m.kind === 'text' ? m.text : `${m.title}\n${m.text}`) : ''
  }
}

function harness() {
  let cfg: BotBridgeConfig = { ...defaultBotConfig(), dingtalk: { clientId: 'x', clientSecret: 'y' } }
  const enqueued: { text: string; ws: string; sid: string }[] = []
  const chat: { id: string; d: string; v?: string; c?: number }[] = []
  const gate: { ws: string; id: string; d: unknown }[] = []
  const lane: { ws: string; id: string; d: unknown }[] = []
  const stopped: { ws: string; sid: string }[] = []
  const bridge = new BotBridge()
  const fake = new FakeTransport()
  bridge.setTransportFactory(() => fake)
  bridge.attach({
    // Clone on read like the real readSettings().botBridge (a fresh Zod parse each call) — returning
    // the same object reference would mask config-object-identity bugs (e.g. attach saving a stale copy).
    readConfig: () => structuredClone(cfg),
    writeConfig: (c) => { cfg = c },
    enqueue: (p) => enqueued.push({ text: p.text, ws: p.workspacePath, sid: p.sessionId }),
    resolveChatGate: (id, d, v, c) => { chat.push({ id, d, v, c }); return true },
    resolveRun2Gate: (ws, id, d) => { gate.push({ ws, id, d }); return true },
    resolveRun2Lane: (ws, id, d) => { lane.push({ ws, id, d }); return true },
    listWorkspaces: () => [{ path: '/ws1', name: 'WS One', sessions: [{ id: 'sess-abc', title: 'Chat A', mode: 'chat' }] }],
    resolveAgentForSession: () => ({ agent: 'claude', agentLabel: 'Claude Code', model: 'opus' }),
    stopSession: (ws, sid) => stopped.push({ ws, sid }),
  })
  return { bridge, fake, enqueued, chat, gate, lane, stopped, cfg: () => cfg }
}

const msg = (text: string, over: Partial<InboundBotMessage> = {}): InboundBotMessage => ({
  platform: 'dingtalk', chatId: 'c1', chatType: 'private', senderId: 'u1', senderName: 'Z', text,
  address: { platform: 'dingtalk', chatId: 'c1', chatType: 'private', userId: 'u1', robotCode: 'r1' },
  ...over,
})

async function attached() {
  const h = harness()
  await h.bridge.connect()
  await h.bridge.handleInbound(msg(`bind ${h.cfg().pairingCode}`))
  await h.bridge.handleInbound(msg('list'))
  const sid = h.cfg().ids.session['sess-abc']       // short id for the only session
  await h.bridge.handleInbound(msg(`attach ${sid}`))
  h.fake.sent.length = 0                              // clear setup chatter
  return { ...h, sid }
}

describe('parseCommand', () => {
  it('recognizes commands (en + zh, slash-optional)', () => {
    expect(parseCommand('list')?.name).toBe('list')
    expect(parseCommand('/列表')?.name).toBe('list')
    expect(parseCommand('attach s3')).toEqual({ name: 'attach', arg: 's3' })
    expect(parseCommand('切 s3')).toEqual({ name: 'attach', arg: 's3' })
    expect(parseCommand('bind 123456')).toEqual({ name: 'bind', arg: '123456' })
    expect(parseCommand('status')?.name).toBe('status')
    expect(parseCommand('hello world')).toBeNull()   // plain text is not a command
  })
})

describe('IdRegistry', () => {
  it('assigns monotonic ids, never reuses, and resolves back', () => {
    const state = { seq: 0, ws: {} as Record<string, string>, session: {} as Record<string, string> }
    const r = new IdRegistry(state, () => {})
    const w = r.idForWs('/a'); const s = r.idForSession('sess')
    expect(w).toBe('w1'); expect(s).toBe('s2')            // single global seq
    expect(r.idForWs('/a')).toBe('w1')                    // stable
    delete state.ws['/a']                                 // "delete" the workspace
    expect(r.idForWs('/b')).toBe('w3')                    // next id, not reused
    expect(r.resolveSession('s2')).toBe('sess')
    expect(r.resolveWs('w1')).toBeNull()                  // '/a' was removed
  })
})

describe('genPairing', () => {
  it('is a 6-digit code', () => { expect(genPairing()).toMatch(/^\d{6}$/) })
})

describe('BotBridge — binding', () => {
  it('rejects a wrong code, binds on the right one, and rotates the code', async () => {
    const h = harness()
    await h.bridge.connect()
    const code = h.cfg().pairingCode
    expect(code).toMatch(/^\d{6}$/)
    await h.bridge.handleInbound(msg('bind 000000'))
    expect(h.fake.lastText()).toContain('配对码不正确')
    expect(h.cfg().bindings).toHaveLength(0)
    await h.bridge.handleInbound(msg(`bind ${code}`))
    expect(h.fake.lastText()).toContain('绑定成功')
    expect(h.cfg().bindings).toHaveLength(1)
    expect(h.cfg().pairingCode).not.toBe(code)            // single-use → rotated
  })

  it('an unbound chat gets only the pairing prompt', async () => {
    const h = harness()
    await h.bridge.connect()
    await h.bridge.handleInbound(msg('list'))
    expect(h.fake.lastText()).toContain('未绑定')
  })
})

describe('BotBridge — commands & new turns', () => {
  it('list shows workspace + session ids', async () => {
    const h = await attached()
    await h.bridge.handleInbound(msg('list'))
    const t = h.fake.lastText()
    expect(t).toContain('WS One')
    expect(t).toContain('Chat A')
    expect(t).toMatch(/w\d/)
  })

  it('a plain message with no pending gate starts a new turn on the focus', async () => {
    const h = await attached()
    await h.bridge.handleInbound(msg('build a login page'))
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]).toEqual({ text: 'build a login page', ws: '/ws1', sid: 'sess-abc' })
    expect(h.fake.lastText()).toContain('已发送')
  })
})

describe('BotBridge — gate answering', () => {
  it('chat ask: numeric reply picks the option', async () => {
    const h = await attached()
    h.bridge.observe('chat:event', {
      workspacePath: '/ws1', sessionId: 'sess-abc', type: 'ask-request', id: 'ca-1',
      title: 'Pick one', options: [{ t: 'A', d: '' }, { t: 'B', d: '' }],
    })
    expect(h.fake.lastText()).toContain('Pick one')
    await h.bridge.handleInbound(msg('2'))
    expect(h.chat).toEqual([{ id: 'ca-1', d: 'allow', v: undefined, c: 1 }])
  })

  it('chat confirm: deny word denies', async () => {
    const h = await attached()
    h.bridge.observe('chat:event', { workspacePath: '/ws1', sessionId: 'sess-abc', type: 'confirm-request', id: 'cc-1', title: '删库?' })
    await h.bridge.handleInbound(msg('deny'))
    expect(h.chat).toEqual([{ id: 'cc-1', d: 'deny', v: undefined, c: undefined }])
  })

  it('run2 gate: "advance" advances', async () => {
    const h = await attached()
    h.bridge.observe('run2:event', { workspacePath: '/ws1', event: { id: 'g1', kind: 'gate', stageKey: 'design', stageName: '设计', body: 'ok?' } })
    expect(h.fake.lastText()).toContain('设计')
    await h.bridge.handleInbound(msg('advance'))
    expect(h.gate).toEqual([{ ws: '/ws1', id: 'g1', d: { type: 'advance' } }])
  })

  it('run2 question lane: free text becomes an answer', async () => {
    const h = await attached()
    h.bridge.observe('run2:event', { workspacePath: '/ws1', event: { id: 'q1', kind: 'question', stageKey: 's', title: '用哪个端口?' } })
    await h.bridge.handleInbound(msg('8080'))
    expect(h.lane).toEqual([{ ws: '/ws1', id: 'q1', d: { type: 'answer', value: '8080' } }])
  })

  it('a resolved gate no longer intercepts the next message', async () => {
    const h = await attached()
    h.bridge.observe('chat:event', { workspacePath: '/ws1', sessionId: 'sess-abc', type: 'confirm-request', id: 'cc-1', title: 'ok?' })
    await h.bridge.handleInbound(msg('allow'))
    await h.bridge.handleInbound(msg('next task'))       // no pending now → new turn
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0].text).toBe('next task')
  })

  it('stop stops the focus session', async () => {
    const h = await attached()
    await h.bridge.handleInbound(msg('stop'))
    expect(h.stopped).toEqual([{ ws: '/ws1', sid: 'sess-abc' }])
  })

  it('attach persists focus across messages (fresh-config identity)', async () => {
    const h = harness()
    await h.bridge.connect()
    await h.bridge.handleInbound(msg(`bind ${h.cfg().pairingCode}`))
    await h.bridge.handleInbound(msg('list'))
    const sid = h.cfg().ids.session['sess-abc']
    await h.bridge.handleInbound(msg(`attach ${sid}`))
    // focus must be persisted to disk, not just mutated on a transient config copy
    expect(h.cfg().bindings[0].focus).toEqual({ workspacePath: '/ws1', sessionId: 'sess-abc' })
    // a following plain message must reach that focus, not fall back to "还没 attach"
    await h.bridge.handleInbound(msg('看看有哪些项目'))
    expect(h.enqueued).toEqual([{ text: '看看有哪些项目', ws: '/ws1', sid: 'sess-abc' }])
  })
})

describe('BotBridge — verbosity', () => {
  it('essential suppresses stage notices; stages emits them', async () => {
    const h = await attached()
    // essential (default): a stage change should NOT push a "进入阶段" notice
    h.bridge.observe('run2:update', { workspacePath: '/ws1', state: { status: 'running', currentStageKey: 'design' } })
    expect(h.fake.sent.find(s => (s.msg.kind === 'text' && s.msg.text.includes('进入阶段')))).toBeUndefined()
    // flip to 'stages'
    const c = h.cfg(); c.verbosity = 'stages'
    h.bridge.observe('run2:update', { workspacePath: '/ws1', state: { status: 'running', currentStageKey: 'develop' } })
    expect(h.fake.sent.some(s => s.msg.kind === 'text' && s.msg.text.includes('进入阶段'))).toBe(true)
  })

  it('a terminal status pushes a completion summary', async () => {
    const h = await attached()
    h.bridge.observe('run2:update', { workspacePath: '/ws1', state: { status: 'done' } })
    expect(h.fake.sent.some(s => s.msg.kind === 'text' && s.msg.text.includes('工作流'))).toBe(true)
  })
})

describe('BotBridge — offline safety', () => {
  it('observe does nothing before connect', () => {
    const h = harness()
    h.bridge.observe('chat:event', { workspacePath: '/ws1', sessionId: 'sess-abc', type: 'confirm-request', id: 'x', title: 't' })
    expect(h.fake.sent).toHaveLength(0)
  })
})
