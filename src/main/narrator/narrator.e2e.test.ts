import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from '../orchestrator/eventBus'
import { Orchestrator } from '../orchestrator/orchestrator'
import { NarratorService } from './narratorService'
import { readMessages } from '../chat/chatStore'
import { readSessions } from '../chat/sessionStore'
import type { AgentProvider, ChatTask, ChatCallbacks } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ne2e-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const msgs = () => readMessages(ws, readSessions(ws).activeSessionId)

function provider(): AgentProvider {
  return {
    id: 'claude', displayName: 'Claude Code', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [] },
    run(task, cb) { cb.onState('run'); const done = (async () => { cb.onState('ok'); const r = { ok: true }; cb.onDone(r); return r })(); return { id: task.agentId, cancel() {}, done } },
    chat(task: ChatTask, cb: ChatCallbacks) { cb.onAssistantDelta('编排摘要'); cb.onDone({ elapsed: 1 }); return { id: task.id, cancel() {}, done: Promise.resolve({ ok: true }) } }
  }
}

describe('narrator e2e', () => {
  it('narrates start + done into chat.jsonl across a real run (orchestrator untouched)', async () => {
    const bus = new EventBus()
    const providers = { claude: provider() }
    const narrator = new NarratorService({ providers, env: () => process.env, emit: () => {}, proxy: () => '' })
    bus.subscribe(e => narrator.onEngineEvent(e))
    const orch = new Orchestrator({ bus, providers, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'r1', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus-4.8' }],
      developProjects: []
    })
    expect(run.status).toBe('ok')
    // start narration + per-stage回流 note (设计 done) + done narration = 3 AI messages
    await vi.waitFor(() => expect(msgs().filter(m => m.who === 'ai')).toHaveLength(3), { timeout: 500 })
    const ai = msgs().filter(m => m.who === 'ai')
    expect(ai.filter(m => m.model?.includes('转述'))).toHaveLength(2)
    const stageNote = ai.find(m => m.model === '系统')
    expect(stageNote).toBeTruthy()
    expect(stageNote!.text).toContain('技术方案设计')
    expect(stageNote!.text).toContain('完成')
  })
})
