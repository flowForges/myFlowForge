import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, ChatCallbacks, ChatTask } from '../agents/types'
import type { DiscoveredSession } from '@shared/types'
import { jsonl, claudeUser, claudeAssistant, claudeStopHook, claudeToolResult, codexMsg, codexEvent } from '../sessionLink/testFixtures'

// 接管官方会话(「在 myFlowForge 继续」):外部存储全在临时目录,只读。

let home: string, roots: Record<'codex' | 'claude' | 'qoder', string>, cwd: string
let registry: string[]
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-to-'))
  process.env.HOME = home
  roots = { codex: join(home, 'x', 'codex'), claude: join(home, 'x', 'claude'), qoder: join(home, 'x', 'qoder') }
  cwd = join(home, 'proj')
  mkdirSync(cwd, { recursive: true })
  registry = []
  vi.resetModules()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const deps = (extra: Record<string, unknown> = {}) => ({
  roots,
  workspaces: () => registry,
  register: (c: string) => { registry.push(c) },
  defaultModel: async (agent: string) => (agent === 'claude' ? 'opus' : 'default'),
  ...extra,
})

const asst = (uuid: string, content: unknown[], stop: string | null = 'end_turn', at = cwd) => ({ ...claudeAssistant(uuid, content, stop), cwd: at })
const appTurn = (n: string, q: string, a: string, at = cwd) => [
  claudeUser(`u-${n}`, q, { cwd: at }),
  asst(`t-${n}`, [{ type: 'tool_use', id: `tu-${n}`, name: 'Bash', input: { command: `ls ${n}` } }], 'tool_use', at),
  claudeToolResult(`r-${n}`, `tu-${n}`),
  asst(`a-${n}`, [{ type: 'text', text: a }], 'end_turn', at),
  claudeStopHook(`s-${n}`),
]
function claudeFile(id: string, body: string): string {
  const f = join(roots.claude, '-proj', `${id}.jsonl`)
  mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, body)
  return f
}
const disc = (source: DiscoveredSession['source'], externalId: string, filePaths: string[], at = cwd): DiscoveredSession =>
  ({ source, externalId, cwd: at, title: '重构登录', startedAt: 1, lastTs: 2, messageCount: 4, filePaths, hasBody: true })

it('claude: creates a session in the transcript cwd, bound to the same id, history tagged 来源 and tools folded', async () => {
  const f = claudeFile('c1', jsonl([...appTurn('0', '帮我重构登录', '好的'), ...appTurn('1', '再加测试', '加好了')]))
  const before = { size: statSync(f).size, mtime: statSync(f).mtimeMs, body: readFileSync(f, 'utf8') }
  const { continueExternal } = await import('./takeover')
  const { readBinding, readMessages, readSession, readWatermark } = await import('../chat/chatStore')
  const { readSessions } = await import('../chat/sessionStore')
  const r = await continueExternal(disc('claude', 'c1', [f], '/somewhere/else'), deps())
  if (!r.ok) throw new Error(r.error)
  expect(r.wsPath).toBe(cwd)                  // the cwd recorded inside the transcript wins
  expect(r.created).toBe(true)
  expect(registry).toEqual([cwd])
  const s = readSessions(cwd).sessions.find(x => x.id === r.sessionId)!
  expect(s.title).toBe('重构登录')
  expect(s.agentId).toBe('claude')
  expect(s.modelId).toBe('opus')
  const b = readBinding(cwd, r.sessionId, 'claude')!
  expect(b).toMatchObject({ resumeId: 'c1', origin: 'imported', extFile: f, cwd })
  expect(b.syncedTo!.offset).toBe(before.size)
  expect(readSession(cwd, r.sessionId, 'claude')).toBe('c1')    // what sendTurn hands the provider as --resume
  const msgs = readMessages(cwd, r.sessionId)
  expect(msgs.map(m => [m.who, m.text])).toEqual([['user', '帮我重构登录'], ['ai', '好的'], ['user', '再加测试'], ['ai', '加好了']])
  for (const m of msgs) expect(m.ext).toMatchObject({ app: 'Claude', agent: 'claude', imported: true })
  expect(msgs[0].id).toBe('ext-claude-c1-u-0')
  expect(msgs[1].tools!.map(t => t.title)).toEqual(['Bash ls 0'])
  expect(readWatermark(cwd, r.sessionId, 'claude')).toBe(4)     // already in the native session: not re-fed
  // never writes the external store
  expect(statSync(f).size).toBe(before.size)
  expect(statSync(f).mtimeMs).toBe(before.mtime)
  expect(readFileSync(f, 'utf8')).toBe(before.body)
})

it('the same external id again just opens the session it already has: no second session, no duplicate history', async () => {
  const f = claudeFile('c1', jsonl(appTurn('0', '问', '答')))
  const { continueExternal } = await import('./takeover')
  const { readMessages } = await import('../chat/chatStore')
  const { readSessions } = await import('../chat/sessionStore')
  const a = await continueExternal(disc('claude', 'c1', [f]), deps())
  const [b, c] = await Promise.all([continueExternal(disc('claude', 'c1', [f]), deps()), continueExternal(disc('claude', 'c1', [f]), deps())])
  if (!a.ok || !b.ok || !c.ok) throw new Error('failed')
  expect(b).toMatchObject({ wsPath: a.wsPath, sessionId: a.sessionId, created: false })
  expect(c).toMatchObject({ sessionId: a.sessionId, created: false })
  expect(readSessions(cwd).sessions.filter(s => !s.readonly).map(s => s.id).filter(id => id === a.sessionId)).toHaveLength(1)
  expect(readSessions(cwd).sessions.filter(s => !s.readonly)).toHaveLength(2)   // the default session + ours
  expect(readMessages(cwd, a.sessionId)).toHaveLength(2)
  expect(registry).toEqual([cwd])
})

it('a Forge session already bound to that id (in any registered workspace) is reused, not duplicated', async () => {
  const f = claudeFile('c9', jsonl(appTurn('0', '问', '答')))
  const other = join(home, 'other'); mkdirSync(other)
  registry.push(other)
  const { writeSession } = await import('../chat/chatStore')
  const { newSession } = await import('../chat/sessionStore')
  const sid = newSession(other).activeSessionId
  writeSession(other, sid, 'claude', 'c9')
  const { continueExternal } = await import('./takeover')
  const r = await continueExternal(disc('claude', 'c9', [f]), deps())
  expect(r).toEqual({ ok: true, wsPath: other, sessionId: sid, created: false, wsAdded: false })
  expect(registry).toEqual([other])
})

it('a huge session imports only the latest 200 plus one 更早的 N 条 row', async () => {
  const rows: unknown[] = []
  for (let i = 0; i < 150; i++) rows.push(claudeUser(`u${i}`, `问${i}`, { cwd }), asst(`a${i}`, [{ type: 'text', text: `答${i}` }]))
  const f = claudeFile('big', jsonl(rows))
  const { continueExternal } = await import('./takeover')
  const { readMessages, readWatermark } = await import('../chat/chatStore')
  const r = await continueExternal(disc('claude', 'big', [f]), deps())
  if (!r.ok) throw new Error(r.error)
  const msgs = readMessages(cwd, r.sessionId)
  expect(msgs).toHaveLength(201)
  expect(msgs[0]).toMatchObject({ text: '', ext: { earlier: 100, imported: true } })
  expect(msgs[1].text).toBe('问50')
  expect(msgs[200].text).toBe('答149')
  expect(readWatermark(cwd, r.sessionId, 'claude')).toBe(201)
})

it('codex: cwd comes from session_meta; the model in the transcript is not forced (user default for the provider)', async () => {
  const f = join(roots.codex, '2026', '06', '15', 'rollout-2026-06-15T21-00-00-cx1.jsonl')
  mkdirSync(join(f, '..'), { recursive: true })
  const meta = { timestamp: '2026-06-15T21:00:00.000Z', type: 'session_meta', payload: { id: 'cx1', timestamp: '2026-06-15T21:00:00.000Z', cwd } }
  const ctx = { timestamp: '2026-06-15T21:00:01.000Z', type: 'turn_context', payload: { cwd, model: 'gpt-9-special' } }
  writeFileSync(f, jsonl([meta, ctx, codexEvent('task_started'), codexMsg('user', '修复构建', 'm1'), codexMsg('assistant', '已修复', 'm2'), codexEvent('task_complete')]))
  const { continueExternal } = await import('./takeover')
  const { readBinding, readMessages } = await import('../chat/chatStore')
  const { readSessions } = await import('../chat/sessionStore')
  const r = await continueExternal(disc('codex', 'cx1', [f], 'unknown'), deps())
  if (!r.ok) throw new Error(r.error)
  expect(r.wsPath).toBe(cwd)
  const s = readSessions(cwd).sessions.find(x => x.id === r.sessionId)!
  expect([s.agentId, s.modelId]).toEqual(['codex', 'default'])
  expect(readBinding(cwd, r.sessionId, 'codex')).toMatchObject({ resumeId: 'cx1', origin: 'imported', extFile: f })
  expect(readMessages(cwd, r.sessionId).map(m => [m.who, m.text, m.ext?.app])).toEqual([['user', '修复构建', 'Codex'], ['ai', '已修复', 'Codex']])
})

it('qoder: the transcript is located under the qoder projects root (the import scan only lists log segments)', async () => {
  const f = join(roots.qoder, '-proj', 'q1.jsonl')
  mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, jsonl(appTurn('0', 'Qoder 里问的', 'Qoder 答')))
  const { continueExternal } = await import('./takeover')
  const { readBinding, readMessages } = await import('../chat/chatStore')
  const r = await continueExternal({ ...disc('qoder', 'q1', [join(home, 'seg.jsonl')]), hasBody: false }, deps())
  if (!r.ok) throw new Error(r.error)
  expect(readBinding(cwd, r.sessionId, 'qoder')).toMatchObject({ resumeId: 'q1', origin: 'imported', extFile: f })
  expect(readMessages(cwd, r.sessionId).map(m => [m.text, m.ext?.app])).toEqual([['Qoder 里问的', 'Qoder'], ['Qoder 答', 'Qoder']])
})

it('canContinue: claude/codex always; qoder only when its transcript can be found; other sources never', async () => {
  const { canContinue } = await import('./takeover')
  expect(await canContinue(disc('claude', 'c', ['/f']), { roots })).toBe(true)
  expect(await canContinue(disc('codex', 'c', ['/f']), { roots })).toBe(true)
  expect(await canContinue(disc('cursor', 'c', ['/f']), { roots })).toBe(false)
  expect(await canContinue(disc('qoder', 'q1', []), { roots })).toBe(false)      // qoder root absent → no entry, no error
  const f = join(roots.qoder, '-proj', 'q1.jsonl'); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, '')
  expect(await canContinue(disc('qoder', 'q1', []), { roots })).toBe(true)
})

it('a missing transcript, a vanished cwd or an unsupported source is an error, nothing is created', async () => {
  const { continueExternal } = await import('./takeover')
  expect((await continueExternal(disc('cursor', 'x', ['/f']), deps())).ok).toBe(false)
  expect((await continueExternal(disc('claude', 'nope', [join(home, 'missing.jsonl')]), deps())).ok).toBe(false)
  const gone = join(home, 'gone')
  const f = claudeFile('c2', jsonl(appTurn('0', '问', '答', gone)))
  expect((await continueExternal(disc('claude', 'c2', [f], gone), deps())).ok).toBe(false)
  expect(registry).toEqual([])
})

it('the read-only copy of the same session (an earlier 导入) is dismissed so it does not sit beside the live one', async () => {
  const f = claudeFile('c1', jsonl(appTurn('0', '问', '答')))
  const { upsertSessions, importIndexFile } = await import('./importStore')
  mkdirSync(join(importIndexFile(), '..'), { recursive: true })
  upsertSessions([disc('claude', 'c1', [f])], 1)
  const { readSessions, newSession } = await import('../chat/sessionStore')
  newSession(cwd)
  expect(readSessions(cwd).sessions.some(s => s.id === 'ext-claude-c1')).toBe(true)
  const { continueExternal } = await import('./takeover')
  const r = await continueExternal(disc('claude', 'c1', [f]), deps())
  if (!r.ok) throw new Error(r.error)
  expect(readSessions(cwd).sessions.some(s => s.id === 'ext-claude-c1')).toBe(false)
  expect(readSessions(cwd).activeSessionId).toBe(r.sessionId)
})

it('after takeover: catch-up shows nothing already imported; a later app turn shows as 在 <App> 中', async () => {
  const f = claudeFile('c1', jsonl(appTurn('0', '问', '答')))
  const { continueExternal } = await import('./takeover')
  const { catchUp } = await import('../sessionLink/handoff')
  const r = await continueExternal(disc('claude', 'c1', [f]), deps())
  if (!r.ok) throw new Error(r.error)
  expect(await catchUp(cwd, r.sessionId, 'claude', { roots })).toEqual([])
  appendFileSync(f, jsonl(appTurn('1', '后来在 App 里问的', '后来的答')))
  const more = await catchUp(cwd, r.sessionId, 'claude', { roots })
  expect(more.map(m => [m.text, m.ext?.imported])).toEqual([['后来在 App 里问的', undefined], ['后来的答', undefined]])
})

it('sending after takeover resumes the same external id natively', async () => {
  const f = claudeFile('c1', jsonl(appTurn('0', '问', '答')))
  const { continueExternal } = await import('./takeover')
  const r = await continueExternal(disc('claude', 'c1', [f]), deps())
  if (!r.ok) throw new Error(r.error)
  const { sendTurn } = await import('../chat/chatService')
  let seen: ChatTask | undefined
  const provider: AgentProvider = {
    id: 'claude', displayName: 'Claude Code',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true },
    async listModels() { return [] },
    run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
    chat(task: ChatTask, cb: ChatCallbacks) {
      seen = task
      queueMicrotask(() => { cb.onSession('c1'); cb.onDone({ elapsed: 1 }) })
      return { id: task.id, cancel: vi.fn(), done: Promise.resolve({ ok: true }) }
    },
  }
  await sendTurn({ workspacePath: cwd, sessionId: r.sessionId, agent: 'claude', agentLabel: 'Claude Code', model: 'opus', text: '接着来', attachments: [] }, { provider, env: process.env, emit: () => {} })
  expect(seen!.sessionId).toBe('c1')
  expect(seen!.cwd).toBe(cwd)
})

it('the pre-send check applies to a taken-over session: still running in the official app → busy there', async () => {
  // the app is mid-turn: a fresh user record with no reply / end marker yet
  const f = claudeFile('c1', jsonl([...appTurn('0', '问', '答'), claudeUser('u-live', '还在 App 里跑的', { cwd })]))
  const { continueExternal } = await import('./takeover')
  const { preSend } = await import('../sessionLink/handoff')
  const r = await continueExternal(disc('claude', 'c1', [f]), deps())
  if (!r.ok) throw new Error(r.error)
  expect((await preSend(cwd, r.sessionId, 'claude', { roots })).busy).toBe('Claude')
  expect((await preSend(cwd, r.sessionId, 'claude', { roots, now: () => Date.now() + 60_000 })).busy).toBeUndefined()
})
