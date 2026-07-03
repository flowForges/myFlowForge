import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/gitRunner'
import { NarratorService } from './narratorService'
import { readMessages } from '../chat/chatStore'
import { readSessions } from '../chat/sessionStore'
import type { AgentProvider, ChatTask, ChatCallbacks } from '../agents/types'
import type { ChatEvent, EngineEvent, RunState } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'narr-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const msgs = () => readMessages(ws, readSessions(ws).activeSessionId)

function chatProvider(record?: (t: ChatTask) => void): AgentProvider {
  return {
    id: 'claude', displayName: 'Claude Code',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [] },
    run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
    chat(task: ChatTask, cb: ChatCallbacks) {
      record?.(task)
      cb.onAssistantDelta('已编排好了'); cb.onDone({ elapsed: 1 })
      return { id: task.id, cancel() {}, done: Promise.resolve({ ok: true }) }
    }
  }
}

function mkRun(status: RunState['status']): RunState {
  return {
    id: 'r1', workspaceName: 'ws', workspacePath: ws, status, projects: [], pending: [],
    stages: [{ key: 'develop', name: '代码开发', state: status, agents: [{ id: 'd1', name: 'web', role: 'r', provider: 'claude', model: 'opus-4.8', state: status, logs: [] }] }]
  }
}

describe('NarratorService', () => {
  it('narrates once at start and once at done, persisting to chat.jsonl', async () => {
    const events: ChatEvent[] = []
    const svc = new NarratorService({ providers: { claude: chatProvider() }, env: () => process.env, emit: (e) => events.push(e), proxy: () => '' })
    const upd = (run: RunState): EngineEvent => ({ type: 'run:update', run })

    svc.onEngineEvent(upd(mkRun('run')))
    await vi.waitFor(() => expect(msgs().filter(m => m.who === 'ai')).toHaveLength(1))
    svc.onEngineEvent(upd(mkRun('run')))
    expect(msgs().filter(m => m.who === 'ai')).toHaveLength(1)

    svc.onEngineEvent(upd(mkRun('ok')))
    await vi.waitFor(() => expect(msgs().filter(m => m.who === 'ai')).toHaveLength(2))
    svc.onEngineEvent(upd(mkRun('ok')))
    expect(msgs().filter(m => m.who === 'ai')).toHaveLength(2)

    const ai = msgs().filter(m => m.who === 'ai')
    expect(ai[0].model).toContain('转述')
    expect(ai[0].think?.label).toBe('编排回顾')
  })

  it('attaches aggregated change totals across run projects to the done message', async () => {
    // a real git project under the run so readChangesMulti sees a diff
    const proj = mkdtempSync(join(tmpdir(), 'narr-proj-'))
    await git(['init', '-b', 'main'], { cwd: proj })
    writeFileSync(join(proj, 'a.txt'), 'a\nb\n')
    await git(['add', '-A'], { cwd: proj })
    await git(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: proj })
    writeFileSync(join(proj, 'new.txt'), 'x\ny\nz\n')      // untracked -> A, +3

    const run: RunState = { ...mkRun('ok'), projects: [{ name: 'p', cwd: proj }] }
    const svc = new NarratorService({ providers: { claude: chatProvider() }, env: () => process.env, emit: () => {}, proxy: () => '' })
    svc.onEngineEvent({ type: 'run:update', run })
    // 'ok' status emits a deterministic stage note AND the LLM done narration; the done
    // narration (with .changes) is the last AI message.
    await vi.waitFor(() => expect(msgs().filter(m => m.model?.includes('转述'))).toHaveLength(1))

    const ai = msgs().filter(m => m.who === 'ai')
    const done = ai[ai.length - 1]
    expect(done.changes).toBeDefined()
    expect(done.changes!.total).toBe(1)
    expect(done.changes!.add).toBe(3)
    expect(done.changes!.del).toBe(0)
    rmSync(proj, { recursive: true, force: true })
  })

  it('skips narration when the provider has no chat()', async () => {
    const noChat: AgentProvider = { ...chatProvider(), chat: undefined }
    const svc = new NarratorService({ providers: { claude: noChat }, env: () => process.env, emit: () => {}, proxy: () => '' })
    svc.onEngineEvent({ type: 'run:update', run: mkRun('run') })
    await new Promise(r => setTimeout(r, 20))
    expect(msgs()).toHaveLength(0)
  })

  it('does not throw when narration fails', () => {
    const throwing: AgentProvider = { ...chatProvider(), chat() { throw new Error('boom') } }
    const svc = new NarratorService({ providers: { claude: throwing }, env: () => process.env, emit: () => {}, proxy: () => '' })
    expect(() => svc.onEngineEvent({ type: 'run:update', run: mkRun('run') })).not.toThrow()
  })
})
