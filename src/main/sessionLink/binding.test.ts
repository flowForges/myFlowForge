import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonl, claudeTurnRows } from './testFixtures'

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

it('asExtProvider: only codex / claude / qoder link to an official app', async () => {
  const { asExtProvider } = await import('./binding')
  expect(asExtProvider('claude')).toBe('claude')
  expect(asExtProvider('codex')).toBe('codex')
  expect(asExtProvider('qoder')).toBe('qoder')
  expect(asExtProvider('gemini')).toBeUndefined()
})

it('ensureSyncedTo: a forge binding without a position starts at the current end of file — no catch-up of our own history', async () => {
  const { writeSession, readBinding } = await import('../chat/chatStore')
  const { ensureSyncedTo } = await import('./binding')
  const { readExternal } = await import('./index')
  const body = jsonl(claudeTurnRows())
  const f = claudeTranscript('c1', body + '{"type":"assistant","half')   // trailing half line stays unconsumed
  writeSession(ws(), 's', 'claude', 'c1')
  const cur = await ensureSyncedTo(ws(), 's', 'claude', { roots })
  expect(cur).toEqual({ offset: Buffer.byteLength(body) })
  expect(readBinding(ws(), 's', 'claude')).toMatchObject({ syncedTo: cur, extFile: f })
  const r = await readExternal('claude', f, cur!)
  expect(r.reset).toBe(false); expect(r.turns).toEqual([])
  // already positioned → unchanged
  appendFileSync(f, '\n')
  expect(await ensureSyncedTo(ws(), 's', 'claude', { roots })).toEqual(cur)
})

it('ensureSyncedTo leaves imported bindings / non-linking agents / missing transcripts alone', async () => {
  const { writeBinding, writeSession, readBinding } = await import('../chat/chatStore')
  const { ensureSyncedTo } = await import('./binding')
  writeBinding(ws(), 's', 'claude', { resumeId: 'c2', origin: 'imported' })
  claudeTranscript('c2', jsonl(claudeTurnRows()))
  expect(await ensureSyncedTo(ws(), 's', 'claude', { roots })).toBeUndefined()
  writeSession(ws(), 's', 'gemini', 'g')
  expect(await ensureSyncedTo(ws(), 's', 'gemini', { roots })).toBeUndefined()
  writeSession(ws(), 's', 'qoder', 'q-none')   // qoder root absent
  expect(await ensureSyncedTo(ws(), 's', 'qoder', { roots })).toBeUndefined()
  expect(readBinding(ws(), 's', 'qoder')).toEqual({ resumeId: 'q-none', origin: 'forge' })
})

it('recordOwnEnd stores the size + mtime our writer left, and moves syncedTo past our own turn', async () => {
  const { writeSession, readBinding, writeBinding } = await import('../chat/chatStore')
  const { recordOwnEnd } = await import('./binding')
  const { isOccupied } = await import('./occupancy')
  const body = jsonl(claudeTurnRows().slice(0, 4))     // unfinished-looking tail (tool_use)
  const f = claudeTranscript('c3', body)
  writeSession(ws(), 's', 'claude', 'c3')
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: 0 } })
  const { appendMessage } = await import('../chat/chatStore')
  appendMessage(ws(), 's', { id: 'm', who: 'user', text: '帮我重构登录流程', ts: '2026-11-26T10:00:00.000Z' } as any)
  await recordOwnEnd(ws(), 's', 'claude', { roots, now: () => 42 })
  const b = readBinding(ws(), 's', 'claude')!
  expect(b.ownEnd).toEqual({ offset: Buffer.byteLength(body), mtimeMs: statSync(f).mtimeMs })
  expect(b.ownLastWriteAt).toBe(42)
  expect(b.syncedTo?.offset).toBe(Buffer.byteLength(body))
  expect(b.extFile).toBe(f)
  expect((await isOccupied('claude', f, statSync(f).mtimeMs + 1_000, { ownEnd: b.ownEnd })).busy).toBe(false)
})

it('recordOwnEnd / ownWriters are no-ops without a linkable binding, and never throw', async () => {
  const { recordOwnEnd, ownWriters } = await import('./binding')
  await expect(recordOwnEnd(join(home, 'nope'), 's', 'claude', { roots })).resolves.toBeUndefined()
  await expect(recordOwnEnd(ws(), 's', 'gemini', { roots })).resolves.toBeUndefined()
  expect(ownWriters(ws(), 's', 'claude')).toEqual({ ownLive: false, otherLive: false })
})

const userMsg = (id: string, text: string, ts: string) => ({ id, who: 'user', text, ts })

it('recordOwnEnd skips only our own turns: an app turn written while our process lingered stays for the next catch-up', async () => {
  const { writeSession, writeBinding, readBinding, appendMessage } = await import('../chat/chatStore')
  const { recordOwnEnd } = await import('./binding')
  const { readExternal } = await import('./index')
  const { claudeUser, claudeAssistant, claudeStopHook } = await import('./testFixtures')
  const before = jsonl([claudeUser('u0', '早先的问题'), claudeAssistant('a0', [{ type: 'text', text: '早先的回答' }]), claudeStopHook('h0')])
  const ours = jsonl([
    claudeUser('u1', '[对话上下文]\n\n帮我  看看 日志'),               // our prompt, wrapped by the provider
    claudeAssistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], 'tool_use'),
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    claudeAssistant('a2', [{ type: 'text', text: '看完了' }]), claudeStopHook('h1'),
    claudeUser('n1', '<task-notification>后台任务完成</task-notification>'),   // our lingering process' own notification turn
    claudeAssistant('a3', [{ type: 'text', text: '后台也好了' }]), claudeStopHook('h2'),
    claudeUser('u2', '第二条'), claudeAssistant('a4', [{ type: 'text', text: '收到' }]), claudeStopHook('h3'),
  ])
  const app = jsonl([claudeUser('x1', '我在 Claude 里问的'), claudeAssistant('xa', [{ type: 'text', text: 'App 的回答' }]), claudeStopHook('xh')])
  const f = claudeTranscript('c9', before + ours + app)
  writeSession(ws(), 's', 'claude', 'c9')
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: Buffer.byteLength(before) }, ownLastWriteAt: Date.parse('2026-11-26T09:00:00Z') })
  appendMessage(ws(), 's', userMsg('m0', '早先的问题', '2026-11-26T08:00:00.000Z') as any)
  appendMessage(ws(), 's', userMsg('m1', '帮我 看看 日志', '2026-11-26T10:00:00.000Z') as any)
  appendMessage(ws(), 's', { id: 'm1a', who: 'ai', text: '看完了', ts: '2026-11-26T10:00:05.000Z' } as any)
  appendMessage(ws(), 's', userMsg('m2', '第二条', '2026-11-26T10:01:00.000Z') as any)
  await recordOwnEnd(ws(), 's', 'claude', { roots, now: () => 7 })
  const b = readBinding(ws(), 's', 'claude')!
  expect(b.syncedTo).toEqual({ offset: Buffer.byteLength(before + ours) })
  expect(b.ownEnd).toEqual({ offset: Buffer.byteLength(before + ours + app), mtimeMs: statSync(f).mtimeMs })
  expect(b.ownLastWriteAt).toBe(7)
  const next = await readExternal('claude', f, b.syncedTo!)
  expect(next.reset).toBe(false)
  expect(next.turns.map(t => t.text)).toEqual(['我在 Claude 里问的', 'App 的回答'])
})

it('recordOwnEnd: an app turn in front of ours stops the advance right there', async () => {
  const { writeSession, writeBinding, readBinding, appendMessage } = await import('../chat/chatStore')
  const { recordOwnEnd } = await import('./binding')
  const { claudeUser, claudeAssistant, claudeStopHook } = await import('./testFixtures')
  const body = jsonl([claudeUser('x1', 'App 先问'), claudeAssistant('xa', [{ type: 'text', text: '答' }]), claudeStopHook('xh'), claudeUser('u1', '我的'), claudeAssistant('a1', [{ type: 'text', text: '好' }])])
  claudeTranscript('c10', body)
  writeSession(ws(), 's', 'claude', 'c10')
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: 0 } })
  appendMessage(ws(), 's', userMsg('m1', '我的', '2026-11-26T10:00:00.000Z') as any)
  await recordOwnEnd(ws(), 's', 'claude', { roots })
  expect(readBinding(ws(), 's', 'claude')!.syncedTo).toEqual({ offset: 0 })
})

it('recordOwnEnd does not write when the resume id changed while it was reading', async () => {
  const { writeSession, writeBinding, readBinding } = await import('../chat/chatStore')
  const { recordOwnEnd } = await import('./binding')
  claudeTranscript('c11', jsonl(claudeTurnRows()))
  writeSession(ws(), 's', 'claude', 'c11')
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: 0 } })
  const p = recordOwnEnd(ws(), 's', 'claude', { roots })
  writeSession(ws(), 's', 'claude', 'c12')       // provider reported a new id meanwhile
  await p
  expect(readBinding(ws(), 's', 'claude')).toEqual({ resumeId: 'c12', origin: 'forge' })
})

it('ownWriters: only a turn in flight counts, and only for this Forge session; another session on the same id is another writer', async () => {
  const { writeSession } = await import('../chat/chatStore')
  const { ownWriters } = await import('./binding')
  const { beginOwnTurn } = await import('./ownTurns')
  writeSession(ws(), 'A', 'claude', 'same-id')
  writeSession(ws(), 'B', 'claude', 'same-id')
  writeSession(ws(), 'C', 'claude', 'other-id')
  const end = beginOwnTurn(ws(), 'A', 'claude')
  expect(ownWriters(ws(), 'A', 'claude')).toEqual({ ownLive: true, otherLive: false })
  expect(ownWriters(ws(), 'B', 'claude')).toEqual({ ownLive: false, otherLive: true })
  expect(ownWriters(ws(), 'C', 'claude')).toEqual({ ownLive: false, otherLive: false })
  const end2 = beginOwnTurn(ws(), 'A', 'claude')    // overlapping (adopted) turn
  end()
  expect(ownWriters(ws(), 'A', 'claude').ownLive).toBe(true)
  end2(); end2()                                      // idempotent
  expect(ownWriters(ws(), 'A', 'claude')).toEqual({ ownLive: false, otherLive: false })
  expect(ownWriters(ws(), 'B', 'claude')).toEqual({ ownLive: false, otherLive: false })
})

it('recordOwnEnd: claude respawn — our message is older than the ownLastWriteAt the old process exit stored, and is still ours', async () => {
  const { writeSession, writeBinding, readBinding, appendMessage } = await import('../chat/chatStore')
  const { recordOwnEnd } = await import('./binding')
  const { claudeUser, claudeAssistant, claudeStopHook } = await import('./testFixtures')
  const first = jsonl([claudeUser('u1', '第一条'), claudeAssistant('a1', [{ type: 'text', text: '一' }]), claudeStopHook('h1')])
  const f = claudeTranscript('c20', first)
  writeSession(ws(), 's', 'claude', 'c20')
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: 0 } })
  appendMessage(ws(), 's', userMsg('m1', '第一条', '2026-11-26T10:00:00.000Z') as any)
  await recordOwnEnd(ws(), 's', 'claude', { roots, now: () => Date.parse('2026-11-26T10:00:30.000Z') })
  expect(readBinding(ws(), 's', 'claude')!.syncedTo!.offset).toBe(Buffer.byteLength(first))
  // T0: sendTurn persists the next message; the provider then stops the old process (respawn for new flags)
  appendMessage(ws(), 's', userMsg('m2', '第二条', '2026-11-26T10:01:00.000Z') as any)
  await recordOwnEnd(ws(), 's', 'claude', { roots, now: () => Date.parse('2026-11-26T10:01:05.000Z') })   // T1 > T0
  expect(readBinding(ws(), 's', 'claude')!.ownLastWriteAt).toBe(Date.parse('2026-11-26T10:01:05.000Z'))
  // the new process writes our record, then exits
  const second = jsonl([claudeUser('u2', '第二条'), claudeAssistant('a2', [{ type: 'text', text: '二' }]), claudeStopHook('h2')])
  appendFileSync(f, second)
  await recordOwnEnd(ws(), 's', 'claude', { roots, now: () => Date.parse('2026-11-26T10:02:00.000Z') })
  expect(readBinding(ws(), 's', 'claude')!.syncedTo!.offset).toBe(Buffer.byteLength(first + second))
})

it('recordOwnEnd: a message already matched is not reused for a later foreign record with the same text', async () => {
  const { writeSession, writeBinding, readBinding, appendMessage } = await import('../chat/chatStore')
  const { recordOwnEnd } = await import('./binding')
  const { claudeUser, claudeAssistant, claudeStopHook } = await import('./testFixtures')
  const ours = jsonl([claudeUser('u1', '继续'), claudeAssistant('a1', [{ type: 'text', text: '好' }]), claudeStopHook('h1')])
  const f = claudeTranscript('c21', ours)
  writeSession(ws(), 's', 'claude', 'c21')
  writeBinding(ws(), 's', 'claude', { syncedTo: { offset: 0 } })
  appendMessage(ws(), 's', userMsg('m1', '继续', '2026-11-26T10:00:00.000Z') as any)
  await recordOwnEnd(ws(), 's', 'claude', { roots })
  appendFileSync(f, jsonl([claudeUser('x1', '继续'), claudeAssistant('xa', [{ type: 'text', text: 'App' }]), claudeStopHook('xh')]))   // typed in the Claude app
  await recordOwnEnd(ws(), 's', 'claude', { roots })
  expect(readBinding(ws(), 's', 'claude')!.syncedTo!.offset).toBe(Buffer.byteLength(ours))
})
