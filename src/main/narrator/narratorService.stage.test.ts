import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NarratorService } from './narratorService'
import { buildStageNote } from './narration'
import { readMessages } from '../chat/chatStore'
import { readSessions } from '../chat/sessionStore'
import type { AgentProvider, ChatTask, ChatCallbacks, LogLine } from '../agents/types'
import type { ChatEvent, EngineEvent, RunState, StageRuntime } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'narr-stage-')) })
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
      cb.onAssistantDelta('转述'); cb.onDone({ elapsed: 1 })
      return { id: task.id, cancel() {}, done: Promise.resolve({ ok: true }) }
    }
  }
}

function log(text: string, level: LogLine['level'] = 'info'): LogLine {
  return { ts: '00:00:00', text, level }
}

function mkRun(stages: StageRuntime[], status: RunState['status'] = 'run'): RunState {
  return { id: 'r1', workspaceName: 'ws', workspacePath: ws, status, projects: [], pending: [], stages }
}

const upd = (run: RunState): EngineEvent => ({ type: 'run:update', run })

describe('NarratorService per-stage回流', () => {
  it('appends exactly one deterministic stage note when a stage becomes ok, idempotently', async () => {
    let chatCalls = 0
    const events: ChatEvent[] = []
    const svc = new NarratorService({
      providers: { claude: chatProvider(() => { chatCalls++ }) },
      env: () => process.env, emit: (e) => events.push(e), proxy: () => ''
    })

    const okStage: StageRuntime = {
      key: 'design', name: '设计', state: 'ok',
      agents: [{ id: 'a1', name: 'arch', role: 'r', provider: 'claude', model: 'm', state: 'ok', logs: [log('交接 → 做了X', 'accent')] }]
    }
    const runStage: StageRuntime = {
      key: 'develop', name: '开发', state: 'run',
      agents: [{ id: 'd1', name: 'web', role: 'r', provider: 'claude', model: 'm', state: 'run', logs: [] }]
    }

    svc.onEngineEvent(upd(mkRun([okStage, runStage])))
    await vi.waitFor(() => {
      const stageNote = msgs().find(m => m.who === 'ai' && m.text === buildStageNote(okStage))
      expect(stageNote).toBeTruthy()
    })

    const noteMsgs = () => msgs().filter(m => m.text === buildStageNote(okStage))
    expect(noteMsgs()).toHaveLength(1)
    expect(noteMsgs()[0].model).toBe('系统')

    // Same stage still ok on a later update → no duplicate
    svc.onEngineEvent(upd(mkRun([okStage, runStage])))
    await new Promise(r => setTimeout(r, 20))
    expect(noteMsgs()).toHaveLength(1)

    // The stage note must be deterministic — provider.chat NOT used for it
    // (chat may be called for the LLM start narration; assert no chat task carried the stage text)
    expect(chatCalls).toBe(1) // only the start narration LLM call
  })

  it('narrates a second stage when it later completes', async () => {
    const svc = new NarratorService({
      providers: { claude: chatProvider() },
      env: () => process.env, emit: () => {}, proxy: () => ''
    })
    const s1: StageRuntime = {
      key: 'design', name: '设计', state: 'ok',
      agents: [{ id: 'a1', name: 'arch', role: 'r', provider: 'claude', model: 'm', state: 'ok', logs: [log('交接 → 做了X', 'accent')] }]
    }
    const s2wait: StageRuntime = {
      key: 'develop', name: '开发', state: 'run',
      agents: [{ id: 'd1', name: 'web', role: 'r', provider: 'claude', model: 'm', state: 'run', logs: [] }]
    }
    svc.onEngineEvent(upd(mkRun([s1, s2wait])))
    await vi.waitFor(() => expect(msgs().some(m => m.text === buildStageNote(s1))).toBe(true))

    const s2ok: StageRuntime = {
      key: 'develop', name: '开发', state: 'ok',
      agents: [{ id: 'd1', name: 'web', role: 'r', provider: 'claude', model: 'm', state: 'ok', logs: [log('交接 → 做了Y', 'accent')] }]
    }
    svc.onEngineEvent(upd(mkRun([s1, s2ok])))
    await vi.waitFor(() => expect(msgs().some(m => m.text === buildStageNote(s2ok))).toBe(true))

    expect(msgs().filter(m => m.text === buildStageNote(s1))).toHaveLength(1)
    expect(msgs().filter(m => m.text === buildStageNote(s2ok))).toHaveLength(1)
  })

  it('an err stage produces a note containing the error tail', async () => {
    const svc = new NarratorService({
      providers: { claude: chatProvider() },
      env: () => process.env, emit: () => {}, proxy: () => ''
    })
    const errStage: StageRuntime = {
      key: 'develop', name: '开发', state: 'err',
      agents: [{ id: 'd1', name: 'web', role: 'r', provider: 'claude', model: 'm', state: 'err', logs: [log('错误: 编译失败 boom')] }]
    }
    svc.onEngineEvent(upd(mkRun([errStage], 'err')))
    await vi.waitFor(() => {
      const note = msgs().find(m => m.text.includes('失败') && m.text.includes('编译失败 boom'))
      expect(note).toBeTruthy()
    })
  })
})
