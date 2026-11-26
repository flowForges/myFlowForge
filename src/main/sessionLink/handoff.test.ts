import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonl, claudeUser, claudeAssistant, claudeStopHook, claudeToolResult, codexMeta, codexMsg, codexEvent } from './testFixtures'

let home: string, roots: Record<'codex' | 'claude' | 'qoder', string>
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-'))
  process.env.HOME = home
  roots = { codex: join(home, 'x', 'codex'), claude: join(home, 'x', 'claude'), qoder: join(home, 'x', 'qoder') }
  vi.resetModules()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const ws = () => join(home, 'ws')
function claudeTranscript(id: string, body: string) {
  const f = join(roots.claude, '-p', `${id}.jsonl`)
  mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, body)
  return f
}
const appTurn = (n: string, q: string, a: string) => [
  claudeUser(`u-${n}`, q),
  claudeAssistant(`t-${n}`, [{ type: 'tool_use', id: `tu-${n}`, name: 'Bash', input: { command: `ls ${n}` } }], 'tool_use'),
  claudeToolResult(`r-${n}`, `tu-${n}`),
  claudeAssistant(`a-${n}`, [{ type: 'text', text: a }]),
  claudeStopHook(`s-${n}`),
]

it('catchUp: turns made in the official app become tagged messages (tools folded into one block), persisted and syncedTo advanced', async () => {
  const { writeSession, readBinding, readMessages } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  const f = claudeTranscript('c1', jsonl(appTurn('0', '我方旧问题', '旧答')))
  writeSession(ws(), 's', 'claude', 'c1')
  // first contact with a forge binding: positions at EOF, never shows our own history
  expect(await catchUp(ws(), 's', 'claude', { roots })).toEqual([])
  appendFileSync(f, jsonl(appTurn('1', '在 App 里问的', 'App 里的回答')))
  const msgs = await catchUp(ws(), 's', 'claude', { roots })
  expect(msgs.map(m => [m.who, m.text, m.ext?.app])).toEqual([
    ['user', '在 App 里问的', 'Claude'],
    ['ai', 'App 里的回答', 'Claude'],
  ])
  expect(msgs[1].tools?.map(t => t.title)).toEqual(['Bash ls 1'])
  expect(msgs[1].tools?.[0].status).toBe('ok')
  expect(readMessages(ws(), 's').map(m => m.id)).toEqual(msgs.map(m => m.id))
  expect(readBinding(ws(), 's', 'claude')!.syncedTo?.offset).toBe(statSync(f).size)
  // nothing new → nothing shown twice
  expect(await catchUp(ws(), 's', 'claude', { roots })).toEqual([])
})

it('catchUp skips our own turns still ahead of syncedTo (claude process lingering) and shows only the app ones', async () => {
  const { writeBinding, writeSession, appendMessage, readBinding } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  const f = claudeTranscript('c2', '')
  writeSession(ws(), 's', 'claude', 'c2')
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: 0 } })
  appendMessage(ws(), 's', { id: 'mine', who: 'user', text: '我方发的', ts: '2026-11-26T10:00:00.000Z' })
  appendMessage(ws(), 's', { id: 'mine-a', who: 'ai', text: '我方的回答', ts: '2026-11-26T10:00:01.000Z' })
  appendFileSync(f, jsonl([
    ...appTurn('own', '<context>…</context>\n我方发的', '我方的回答'),
    claudeUser('n1', '<task-notification>done</task-notification>'),
    claudeAssistant('n1a', [{ type: 'text', text: '后台完成' }]),
    ...appTurn('app', 'App 里的', 'App 答'),
  ]))
  const msgs = await catchUp(ws(), 's', 'claude', { roots })
  expect(msgs.map(m => m.text)).toEqual(['App 里的', 'App 答'])
  expect(readBinding(ws(), 's', 'claude')!.ownMsgMark).toBe('mine')
})

it('catchUp continues an app turn whose records straddle two reads; our own reply tail is never shown', async () => {
  const { writeBinding, writeSession, appendMessage } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  const f = claudeTranscript('c3', '')
  writeSession(ws(), 's', 'claude', 'c3')
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: 0 } })
  appendFileSync(f, jsonl([claudeUser('x1', 'App 提问')]))
  expect((await catchUp(ws(), 's', 'claude', { roots })).map(m => m.text)).toEqual(['App 提问'])
  appendFileSync(f, jsonl([claudeAssistant('x2', [{ type: 'text', text: 'App 回答' }])]))
  expect((await catchUp(ws(), 's', 'claude', { roots })).map(m => m.text)).toEqual(['App 回答'])
  // now our own message and its reply, the reply landing after a catch-up
  appendMessage(ws(), 's', { id: 'm2', who: 'user', text: '我方第二条', ts: '2026-11-26T10:00:00.000Z' })
  appendFileSync(f, jsonl([claudeUser('y1', '我方第二条')]))
  expect(await catchUp(ws(), 's', 'claude', { roots })).toEqual([])
  appendFileSync(f, jsonl([claudeAssistant('y2', [{ type: 'text', text: '我方回答' }])]))
  expect(await catchUp(ws(), 's', 'claude', { roots })).toEqual([])
})

it('catchUp after a rewrite (reset) re-reads without showing anything twice', async () => {
  const { writeBinding, writeSession, appendMessage, readMessages } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  const rows = [...appTurn('own', '我方的', '我方答'), ...appTurn('app', 'App 的', 'App 答')]
  const f = claudeTranscript('c4', jsonl(rows))
  writeSession(ws(), 's', 'claude', 'c4')
  appendMessage(ws(), 's', { id: 'mine', who: 'user', text: '我方的', ts: '2026-11-26T10:00:00.000Z' })
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: Buffer.byteLength(jsonl(appTurn('own', '我方的', '我方答'))) } })
  expect((await catchUp(ws(), 's', 'claude', { roots })).map(m => m.text)).toEqual(['App 的', 'App 答'])
  // rewritten: same content plus one more app turn, but the cursor fingerprint no longer matches
  writeFileSync(f, jsonl([{ type: 'mode', mode: 'x' }, ...rows, ...appTurn('app2', 'App 第二问', 'App 第二答')]))
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: 5, lastId: '1:deadbeef' } })
  expect((await catchUp(ws(), 's', 'claude', { roots })).map(m => m.text)).toEqual(['App 第二问', 'App 第二答'])
  expect(readMessages(ws(), 's').filter(m => m.ext).length).toBe(4)
})

it('catchUp caps a huge backlog to the latest 200 messages behind one 更早的 N 条 row', async () => {
  const { writeBinding, writeSession, readMessages } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  const rows: unknown[] = []
  for (let i = 0; i < 150; i++) rows.push(claudeUser(`u${i}`, `q${i}`), claudeAssistant(`a${i}`, [{ type: 'text', text: `a${i}` }]))
  claudeTranscript('c5', jsonl(rows))
  writeBinding(ws(), 's', 'claude', { resumeId: 'c5', origin: 'imported', syncedTo: { offset: 0 } })
  void writeSession
  const msgs = await catchUp(ws(), 's', 'claude', { roots })
  expect(msgs.length).toBe(201)
  expect(msgs[0].ext?.earlier).toBe(100)
  expect(msgs[1].text).toBe('q50')
  expect(msgs[200].text).toBe('a149')
  expect(readMessages(ws(), 's').length).toBe(201)
})

it('catchUp does nothing while our own turn is in flight, for other agents, or when the transcript is missing', async () => {
  const { writeBinding, writeSession, readBinding } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  const { beginOwnTurn } = await import('./ownTurns')
  claudeTranscript('c6', jsonl(appTurn('1', 'q', 'a')))
  writeBinding(ws(), 's', 'claude', { resumeId: 'c6', syncedTo: { offset: 0 } })
  const end = beginOwnTurn(ws(), 's', 'claude')
  expect(await catchUp(ws(), 's', 'claude', { roots })).toEqual([])
  expect(readBinding(ws(), 's', 'claude')!.syncedTo).toEqual({ offset: 0 })
  end()
  writeSession(ws(), 's', 'gemini', 'g1')
  expect(await catchUp(ws(), 's', 'gemini', { roots })).toEqual([])
  writeSession(ws(), 's', 'qoder', 'q1')
  expect(await catchUp(ws(), 's', 'qoder', { roots })).toEqual([])
})

it('catchUp keeps a caught-up provider watermark caught up (the app turns are already in its native session)', async () => {
  const { writeBinding, writeWatermark, readWatermark, appendMessage } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  claudeTranscript('c7', jsonl(appTurn('1', 'q', 'a')))
  appendMessage(ws(), 's', { id: 'm', who: 'ai', text: 'x', ts: '' })
  writeBinding(ws(), 's', 'claude', { resumeId: 'c7', syncedTo: { offset: 0 } })
  writeWatermark(ws(), 's', 'claude', 1)
  await catchUp(ws(), 's', 'claude', { roots })
  expect(readWatermark(ws(), 's', 'claude')).toBe(3)
})

it('catchUp records cwd from the external transcript', async () => {
  const { writeBinding, readBinding } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  const f = join(roots.codex, '2026', '06', '15', 'rollout-2026-06-15T21-00-00-cx1.jsonl')
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, jsonl([codexMeta('/Users/me/elsewhere'), codexEvent('task_started'), codexMsg('user', 'App 问', 'm1'), codexMsg('assistant', 'App 答', 'm2'), codexEvent('task_complete')]))
  writeBinding(ws(), 's', 'codex', { resumeId: 'cx1', origin: 'imported', syncedTo: { offset: 0 } })
  const msgs = await catchUp(ws(), 's', 'codex', { roots })
  expect(msgs.map(m => [m.text, m.ext?.app])).toEqual([['App 问', 'Codex'], ['App 答', 'Codex']])
  expect(readBinding(ws(), 's', 'codex')!.cwd).toBe('/Users/me/elsewhere')
})

it('preSend: catches up, then reports busy while the app is mid-turn; another Forge session on the same id is myFlowForge', async () => {
  const { writeBinding } = await import('../chat/chatStore')
  const { preSend } = await import('./handoff')
  const { beginOwnTurn } = await import('./ownTurns')
  const f = claudeTranscript('c8', jsonl([claudeUser('u1', 'App 正在问')]))
  writeBinding(ws(), 's', 'claude', { resumeId: 'c8', syncedTo: { offset: 0 } })
  const r = await preSend(ws(), 's', 'claude', { roots })
  expect(r.appended.map(m => m.text)).toEqual(['App 正在问'])
  expect(r.busy).toBe('Claude')
  appendFileSync(f, jsonl([claudeAssistant('a1', [{ type: 'text', text: '答' }]), claudeStopHook('s1')]))
  expect((await preSend(ws(), 's', 'claude', { roots })).busy).toBeUndefined()
  writeBinding(ws(), 'other', 'claude', { resumeId: 'c8' })
  const end = beginOwnTurn(ws(), 'other', 'claude')
  expect((await preSend(ws(), 's', 'claude', { roots })).busy).toBe('myFlowForge')
  end()
  expect((await preSend(ws(), 's', 'gemini', { roots }))).toEqual({ appended: [] })
})

it('isActiveWriterError recognises codex refusing a second writer', async () => {
  const { isActiveWriterError } = await import('./handoff')
  expect(isActiveWriterError('thread 019a already has an active writer')).toBe(true)
  expect(isActiveWriterError('Reconnecting... 2/5')).toBe(false)
})
