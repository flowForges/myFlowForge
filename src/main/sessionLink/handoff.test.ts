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

// ---- fix round 1 ----
function codexTranscript(id: string, body: string) {
  const f = join(roots.codex, '2026', '06', '15', `rollout-2026-06-15T21-00-00-${id}.jsonl`)
  mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, body)
  return f
}
// no ids → the readers fall back to the line offset (`@0`, …)
const bareCodex = (q: string, a: string) => jsonl([codexMsg('user', q), codexMsg('assistant', a), codexEvent('task_complete')])
const bareClaudeUser = (q: string) => ({ type: 'user', message: { role: 'user', content: q }, timestamp: '2026-06-01T00:01:00.000Z' })
const bareClaudeAnswer = (a: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: a }], stop_reason: 'end_turn' }, timestamp: '2026-06-01T00:02:00.000Z' })

it('ids are namespaced by agent + resume id: a new external session with the same offsets is still shown', async () => {
  const { writeBinding, readMessages } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  codexTranscript('cxa', bareCodex('第一个会话问', '第一个会话答'))
  writeBinding(ws(), 's', 'codex', { resumeId: 'cxa', origin: 'imported', syncedTo: { offset: 0 } })
  expect((await catchUp(ws(), 's', 'codex', { roots })).map(m => m.text)).toEqual(['第一个会话问', '第一个会话答'])
  codexTranscript('cxb', bareCodex('第二个会话问', '第二个会话答'))
  writeBinding(ws(), 's', 'codex', { resumeId: 'cxb', origin: 'imported', syncedTo: { offset: 0 } })
  const msgs = await catchUp(ws(), 's', 'codex', { roots })
  expect(msgs.map(m => m.text)).toEqual(['第二个会话问', '第二个会话答'])
  expect(msgs[0].ext?.id).toBe('@0')                 // the raw external id is kept
  expect(new Set(readMessages(ws(), 's').map(m => m.id)).size).toBe(4)
})

it('two bindings in one session (claude + codex) at the same offsets do not swallow each other', async () => {
  const { writeBinding, readMessages } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  claudeTranscript('cl', jsonl([bareClaudeUser('Claude 问'), bareClaudeAnswer('Claude 答')]))
  codexTranscript('cx', bareCodex('Codex 问', 'Codex 答'))
  writeBinding(ws(), 's', 'claude', { resumeId: 'cl', origin: 'imported', syncedTo: { offset: 0 } })
  writeBinding(ws(), 's', 'codex', { resumeId: 'cx', origin: 'imported', syncedTo: { offset: 0 } })
  await catchUp(ws(), 's', 'claude', { roots })
  await catchUp(ws(), 's', 'codex', { roots })
  expect(readMessages(ws(), 's').map(m => m.text)).toEqual(['Claude 问', 'Claude 答', 'Codex 问', 'Codex 答'])
})

it('a rewrite that puts different content at an already-shown offset shows the new content', async () => {
  const { writeBinding } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  const f = codexTranscript('cxr', bareCodex('旧问', '旧答'))
  writeBinding(ws(), 's', 'codex', { resumeId: 'cxr', origin: 'imported', syncedTo: { offset: 0 } })
  await catchUp(ws(), 's', 'codex', { roots })
  writeFileSync(f, bareCodex('新问!', '新答!'))       // same line layout, different bytes → reset
  expect((await catchUp(ws(), 's', 'codex', { roots })).map(m => m.text)).toEqual(['新问!', '新答!'])
})

it('records continuing the previous owner only continue the SAME app: our codex reply after a claude app turn stays hidden', async () => {
  const { writeBinding, appendMessage } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  const fx = codexTranscript('cxm', '')
  writeBinding(ws(), 's', 'codex', { resumeId: 'cxm', syncedTo: { offset: 0 } })
  appendMessage(ws(), 's', { id: 'mine', who: 'user', text: '我方问 codex', ts: '2026-11-26T10:00:00.000Z' })
  appendFileSync(fx, jsonl([codexMsg('user', '我方问 codex', 'm1')]))
  expect(await catchUp(ws(), 's', 'codex', { roots })).toEqual([])
  // meanwhile a claude app turn is caught up — the last stored message is now a Claude ext message
  claudeTranscript('clm', jsonl([claudeUser('cu', 'Claude App 问')]))
  writeBinding(ws(), 's', 'claude', { resumeId: 'clm', origin: 'imported', syncedTo: { offset: 0 } })
  expect((await catchUp(ws(), 's', 'claude', { roots })).map(m => m.text)).toEqual(['Claude App 问'])
  appendFileSync(fx, jsonl([codexMsg('assistant', '我方 codex 的回答', 'm2'), codexEvent('task_complete')]))
  expect(await catchUp(ws(), 's', 'codex', { roots })).toEqual([])
})

it('catchUp on open and on send at the same moment appends the app turns once', async () => {
  const { writeBinding, readMessages } = await import('../chat/chatStore')
  const { catchUp, preSend } = await import('./handoff')
  claudeTranscript('cc', jsonl(appTurn('1', 'App 问', 'App 答')))
  writeBinding(ws(), 's', 'claude', { resumeId: 'cc', origin: 'imported', syncedTo: { offset: 0 } })
  const [a, b] = await Promise.all([catchUp(ws(), 's', 'claude', { roots }), preSend(ws(), 's', 'claude', { roots })])
  expect(a.length + b.appended.length).toBe(2)
  expect(readMessages(ws(), 's').map(m => m.text)).toEqual(['App 问', 'App 答'])
})

it('a missing transcript is not searched for again for 10 minutes (unless our own turn just wrote it)', async () => {
  const { writeBinding } = await import('../chat/chatStore')
  const { resolveBindingFile, MISS_TTL_MS } = await import('./binding')
  writeBinding(ws(), 's', 'claude', { resumeId: 'late' })
  let t = 1_000_000
  const now = () => t
  expect(await resolveBindingFile(ws(), 's', 'claude', { roots, now })).toBeUndefined()
  const f = claudeTranscript('late', jsonl(appTurn('1', 'q', 'a')))
  t += MISS_TTL_MS - 1
  expect(await resolveBindingFile(ws(), 's', 'claude', { roots, now })).toBeUndefined()
  expect(await resolveBindingFile(ws(), 's', 'claude', { roots, now, fresh: true })).toBe(f)
  writeBinding(ws(), 's2', 'claude', { resumeId: 'late2' })
  expect(await resolveBindingFile(ws(), 's2', 'claude', { roots, now })).toBeUndefined()
  claudeTranscript('late2', jsonl(appTurn('1', 'q', 'a')))
  t += MISS_TTL_MS + 1
  expect(await resolveBindingFile(ws(), 's2', 'claude', { roots, now })).toBeDefined()
})

// ---- own-message matching (final review I1 / I2) ----
const HIST = (pairs: [string, string][]) => `【历史对话(续)】\n${pairs.map(([q, a]) => `用户：${q}\n助手：${a}`).join('\n')}\n【以上为历史，请先通读理解，在此基础上继续，并自行总结要点】`
const own = (id: string, text: string) => ({ id, who: 'user' as const, text, ts: '2026-11-26T10:00:00.000Z' })
const ai = (id: string, text: string) => ({ id, who: 'ai' as const, text, ts: '2026-11-26T10:00:01.000Z' })

it('codex re-sends history every turn: our record is matched by its END, the mark keeps up, and an app message equal to our last one is shown', async () => {
  const { writeSession, appendMessage, readBinding } = await import('../chat/chatStore')
  const { recordOwnEnd } = await import('./binding')
  const { catchUp } = await import('./handoff')
  // turn 1: first codex turn — the binding appears with the turn, recordOwnEnd positions at EOF
  appendMessage(ws(), 's', own('m1', '你好'))
  const f = codexTranscript('cxh', bareCodex('你好', 'hi'))
  writeSession(ws(), 's', 'codex', 'cxh')
  await recordOwnEnd(ws(), 's', 'codex', { roots })
  expect(readBinding(ws(), 's', 'codex')!.ownMsgMark).toBe('m1')
  // turn 2: the record carries the whole history in front of our text
  appendMessage(ws(), 's', ai('m1a', 'hi'))
  appendMessage(ws(), 's', own('m2', '继续'))
  appendFileSync(f, bareCodex(`${HIST([['你好', 'hi']])}\n继续`, 'ok'))
  await recordOwnEnd(ws(), 's', 'codex', { roots })
  expect(readBinding(ws(), 's', 'codex')!.ownMsgMark).toBe('m2')
  expect(readBinding(ws(), 's', 'codex')!.syncedTo!.offset).toBe(statSync(f).size)
  // 在 Codex 中继续: the user types the same short word in the app
  appendFileSync(f, bareCodex('继续', 'App 的回答'))
  expect((await catchUp(ws(), 's', 'codex', { roots })).map(m => m.text)).toEqual(['继续', 'App 的回答'])
})

it('with several unmatched candidates the record is credited to the message it ENDS with (the latest), not the oldest it contains', async () => {
  const { writeBinding, appendMessage, readBinding } = await import('../chat/chatStore')
  const { catchUp } = await import('./handoff')
  appendMessage(ws(), 's', own('m1', '你好'))
  appendMessage(ws(), 's', ai('m1a', 'hi'))
  appendMessage(ws(), 's', own('m2', '继续'))
  const f = codexTranscript('cxl', bareCodex(`${HIST([['你好', 'hi']])}\n继续`, 'ok'))
  writeBinding(ws(), 's', 'codex', { resumeId: 'cxl', syncedTo: { offset: 0 } })   // no mark yet: both are candidates
  expect(await catchUp(ws(), 's', 'codex', { roots })).toEqual([])
  expect(readBinding(ws(), 's', 'codex')!.ownMsgMark).toBe('m2')
  appendFileSync(f, bareCodex('继续', 'App 答'))
  expect((await catchUp(ws(), 's', 'codex', { roots })).map(m => m.text)).toEqual(['继续', 'App 答'])
})

it('codex: everything written between the start of our turn and its end is ours, even a record that matches nothing (attachment-only)', async () => {
  const { writeBinding, appendMessage, readBinding, readMessages } = await import('../chat/chatStore')
  const { recordOwnEnd, markOwnStart } = await import('./binding')
  const { catchUp } = await import('./handoff')
  appendMessage(ws(), 's', own('m1', '看图'))
  const f = codexTranscript('cxa2', bareCodex('看图', '好'))
  writeBinding(ws(), 's', 'codex', { resumeId: 'cxa2', syncedTo: { offset: statSync(join(roots.codex, '2026', '06', '15', 'rollout-2026-06-15T21-00-00-cxa2.jsonl')).size }, ownMsgMark: 'm1' })
  appendMessage(ws(), 's', ai('m1a', '好'))
  appendMessage(ws(), 's', own('m2', ''))        // attachment-only: no text to match
  await markOwnStart(ws(), 's', 'codex', { roots })
  appendFileSync(f, bareCodex('<image name="a.png">', '图里是一只猫'))
  // a catch-up racing the end of our turn must not show it
  const [shown] = await Promise.all([catchUp(ws(), 's', 'codex', { roots }), recordOwnEnd(ws(), 's', 'codex', { roots })])
  expect(shown).toEqual([])
  const b = readBinding(ws(), 's', 'codex')!
  expect(b.syncedTo!.offset).toBe(statSync(f).size)
  expect(b.ownMsgMark).toBe('m2')
  expect(await catchUp(ws(), 's', 'codex', { roots })).toEqual([])
  appendFileSync(f, bareCodex('App 里问', 'App 答'))
  expect((await catchUp(ws(), 's', 'codex', { roots })).map(m => m.text)).toEqual(['App 里问', 'App 答'])
  expect(readMessages(ws(), 's').some(m => m.text === '图里是一只猫')).toBe(false)
})

it('codex: an app turn that was already there before our turn started still stops the advance', async () => {
  const { writeBinding, appendMessage, readBinding } = await import('../chat/chatStore')
  const { recordOwnEnd, markOwnStart } = await import('./binding')
  appendMessage(ws(), 's', own('m1', '我的'))
  const f = codexTranscript('cxp', '')
  writeBinding(ws(), 's', 'codex', { resumeId: 'cxp', syncedTo: { offset: 0 } })
  appendFileSync(f, bareCodex('App 先问', 'App 答'))   // not caught up yet
  await markOwnStart(ws(), 's', 'codex', { roots })
  appendFileSync(f, bareCodex('我的', '好'))
  await recordOwnEnd(ws(), 's', 'codex', { roots })
  expect(readBinding(ws(), 's', 'codex')!.syncedTo).toEqual({ offset: 0 })
})

it('a user record that starts with one of our own prompt headers is ours (no text to match), for catch-up and recordOwnEnd alike', async () => {
  const { writeBinding, appendMessage, readBinding } = await import('../chat/chatStore')
  const { recordOwnEnd } = await import('./binding')
  const { catchUp } = await import('./handoff')
  appendMessage(ws(), 's', own('m1', ''))
  const heads = [
    '【你离开期间本会话继续了以下对话】\n用户：a\n【以上为你离开期间的对话】',
    '<format-html-visual>\n…\n</format-html-visual>\n【历史对话(续)】\n用户：a',
    '【工作流「发版」· 第 1/3 步:写方案】\n…',
    '# 记忆上下文(供参考,不要复述)\n\n## 系统记忆\nx',
  ]
  const f = codexTranscript('cxk', jsonl(heads.flatMap((h, i) => [codexMsg('user', h), codexMsg('assistant', `我方答 ${i}`), codexEvent('task_complete')])) + bareCodex('App 问', 'App 答'))
  writeBinding(ws(), 's', 'codex', { resumeId: 'cxk', syncedTo: { offset: 0 } })
  expect((await catchUp(ws(), 's', 'codex', { roots })).map(m => m.text)).toEqual(['App 问', 'App 答'])
  // claude keeps text matching, plus the header rule
  const cf = claudeTranscript('clk', jsonl([claudeUser('u1', heads[0]), claudeAssistant('a1', [{ type: 'text', text: '我方' }]), claudeStopHook('h1')]))
  writeBinding(ws(), 's', 'claude', { resumeId: 'clk', syncedTo: { offset: 0 } })
  await recordOwnEnd(ws(), 's', 'claude', { roots })
  expect(readBinding(ws(), 's', 'claude')!.syncedTo!.offset).toBe(statSync(cf).size)
})

it('R4: qoder is not range-credited — a record that matches nothing written during our turn is still left for catch-up', async () => {
  const { writeBinding, appendMessage, readBinding } = await import('../chat/chatStore')
  const { recordOwnEnd, markOwnStart } = await import('./binding')
  appendMessage(ws(), 's', own('m1', '我的'))
  const f = join(roots.qoder, '-p', 'q-r4.jsonl')
  mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, '')
  writeBinding(ws(), 's', 'qoder', { resumeId: 'q-r4', syncedTo: { offset: 0 }, ownMsgMark: 'm1' })
  await markOwnStart(ws(), 's', 'qoder', { roots })
  appendFileSync(f, jsonl([claudeUser('x1', 'Qoder 里问的'), claudeAssistant('xa', [{ type: 'text', text: '答' }]), claudeStopHook('xh')]))
  await recordOwnEnd(ws(), 's', 'qoder', { roots })
  expect(readBinding(ws(), 's', 'qoder')!.syncedTo).toEqual({ offset: 0 })
})

it('R5: a record ending with two of our messages is credited to the LONGEST one — A="修复登录bug,然后继续" then B="继续" are both ours', async () => {
  const { writeBinding, appendMessage, readBinding } = await import('../chat/chatStore')
  const { recordOwnEnd } = await import('./binding')
  const { catchUp } = await import('./handoff')
  const A = '修复登录bug,然后继续', B = '继续'
  const body = jsonl([
    claudeUser('ua', A), claudeAssistant('aa', [{ type: 'text', text: '修好了' }]), claudeStopHook('ha'),
    claudeUser('ub', `[对话上下文] ${B}`), claudeAssistant('ab', [{ type: 'text', text: '继续中' }]), claudeStopHook('hb'),
  ])
  for (const [sid, id] of [['s-walk', 'c-r5a'], ['s-catch', 'c-r5b']] as const) {
    claudeTranscript(id, body)
    appendMessage(ws(), sid, own('mA', A)); appendMessage(ws(), sid, ai('mAa', '修好了')); appendMessage(ws(), sid, own('mB', B))
    writeBinding(ws(), sid, 'claude', { resumeId: id, syncedTo: { offset: 0 } })   // both unmatched candidates
  }
  // pastOwnTurns (recordOwnEnd)
  await recordOwnEnd(ws(), 's-walk', 'claude', { roots })
  expect(readBinding(ws(), 's-walk', 'claude')!.syncedTo!.offset).toBe(Buffer.byteLength(body))
  expect(readBinding(ws(), 's-walk', 'claude')!.ownMsgMark).toBe('mB')
  // appTurns (catchUp)
  expect(await catchUp(ws(), 's-catch', 'claude', { roots })).toEqual([])
  expect(readBinding(ws(), 's-catch', 'claude')!.ownMsgMark).toBe('mB')
})
