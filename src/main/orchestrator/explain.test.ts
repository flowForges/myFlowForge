import { describe, it, expect, vi } from 'vitest'
import { runExplain, buildExplainPrompt, normalizeNote } from './explain'
import type { AgentProvider } from '../agents/types'

function chatProvider(text: string): AgentProvider {
  return {
    id: 'cp', displayName: 'CP',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: false } as any,
    async detect() { return true },
    async listModels() { return [] },
    run(task) { return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true, summary: '' }) } },
    chat(task, cb) {
      const done = (async () => { cb.onAssistantDelta(text); cb.onDone({ elapsed: 0 }); return { ok: true, summary: '' } })()
      return { id: task.id, cancel() {}, done }
    },
  }
}

describe('normalizeNote', () => {
  it('折叠空白、去首尾、截断到 120', () => {
    expect(normalizeNote('  多  行\n解释  ')).toBe('多 行 解释')
    expect(normalizeNote('x'.repeat(200)).length).toBe(120)
  })
})

describe('buildExplainPrompt', () => {
  it('含子代理名与问题原文,选项时含选项', () => {
    const p = buildExplainPrompt('确认闸', '要删除 dist 吗', [{ t: '删', d: '删掉' }, { t: '留', d: '保留' }])
    expect(p).toContain('确认闸')
    expect(p).toContain('要删除 dist 吗')
    expect(p).toContain('删')
  })
})

describe('runExplain', () => {
  it('拿到一句解释后回调 onNote(归一化)', async () => {
    let noted: { id: string; note: string } | null = null
    runExplain(chatProvider('  这是\n一句解释  '), { pendingId: 'p1', name: 'X', model: 'm', cwd: '/tmp', question: 'q', env: {} }, (id, note) => { noted = { id, note } })
    await new Promise(r => setTimeout(r, 5))
    expect(noted).toEqual({ id: 'p1', note: '这是 一句解释' })
  })

  it('provider 无 chat 能力时静默跳过(不回调)', async () => {
    const onNote = vi.fn()
    const noChat = { ...chatProvider('x') }
    delete (noChat as any).chat
    runExplain(noChat as AgentProvider, { pendingId: 'p1', name: 'X', model: 'm', cwd: '/tmp', question: 'q', env: {} }, onNote)
    await new Promise(r => setTimeout(r, 5))
    expect(onNote).not.toHaveBeenCalled()
  })

  it('空解释不回调', async () => {
    const onNote = vi.fn()
    runExplain(chatProvider('   '), { pendingId: 'p1', name: 'X', model: 'm', cwd: '/tmp', question: 'q', env: {} }, onNote)
    await new Promise(r => setTimeout(r, 5))
    expect(onNote).not.toHaveBeenCalled()
  })
})
