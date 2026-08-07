import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import { readSessions } from './sessionStore'
import { readMessages } from './chatStore'
import { INLINE_HTML_DIRECTIVE } from './inlineHtmlDirective'
import type { ChatTask, ChatCallbacks } from '../agents/types'

// 只覆盖 appearance.chatInlineHtml 这一项,其余走真实设置。
let inlineHtml = false
vi.mock('../config/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/store')>()
  return {
    ...actual,
    readSettings: () => {
      const s = actual.readSettings()
      return { ...s, appearance: { ...s.appearance, chatInlineHtml: inlineHtml } }
    },
  }
})

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'cshtml-')); inlineHtml = false })
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

function recordingProvider() {
  const prompts: string[] = []
  const provider: any = {
    chat: (task: ChatTask, cb: ChatCallbacks) => {
      prompts.push(task.prompt)
      cb.onAssistantDelta('好的')
      cb.onDone({ elapsed: 1 })
      return { id: task.id, cancel: () => {}, done: Promise.resolve({ ok: true }) }
    },
  }
  return { provider, prompts }
}

const send = async (text: string): Promise<string[]> => {
  const sid = readSessions(ws).sessions[0].id
  const { provider, prompts } = recordingProvider()
  await sendTurn(
    { workspacePath: ws, sessionId: sid, agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text, attachments: [] },
    { provider, env: {}, emit: () => {} },
  )
  return prompts
}

describe('内嵌 HTML 格式指令注入', () => {
  it('开关关掉时完全不注入(默认状态,零成本)', async () => {
    const prompts = await send('帮我对比一下这几个方案')
    expect(prompts[0]).not.toContain('format-html-visual')
    expect(prompts[0]).toContain('帮我对比一下这几个方案')
  })

  it('开关打开时前置格式指令', async () => {
    inlineHtml = true
    const prompts = await send('帮我对比一下这几个方案')
    expect(prompts[0]).toContain(INLINE_HTML_DIRECTIVE)
    expect(prompts[0].indexOf('format-html-visual')).toBeLessThan(prompts[0].indexOf('帮我对比一下这几个方案'))
  })

  it('★ 指令不进存档 —— 存的是用户原话', async () => {
    inlineHtml = true
    const sid = readSessions(ws).sessions[0].id
    await send('帮我对比一下这几个方案')
    const stored = readMessages(ws, sid).find(m => m.who === 'user')
    expect(stored?.text).toBe('帮我对比一下这几个方案')
    expect(stored?.text).not.toContain('format-html-visual')
  })

  it('每轮都注入 —— resume 不可靠的 provider 会静默丢历史,一次性注入等于开一轮就失效', async () => {
    inlineHtml = true
    await send('第一轮')
    const prompts = await send('第二轮')
    expect(prompts[0]).toContain('format-html-visual')
  })
})

describe('格式指令内容约束', () => {
  it('★ 不教模型写 <script> —— 渲染端不会构造它,写了纯属浪费 token 且与实际渲染对不上', () => {
    expect(INLINE_HTML_DIRECTIVE).not.toMatch(/输出\s*<script/)
    expect(INLINE_HTML_DIRECTIVE).toContain('不要用 <script>')
  })
  it('劝模型把表格和代码块留给 Markdown 原生语法', () => {
    expect(INLINE_HTML_DIRECTIVE).toContain('<table>/<pre>')
    expect(INLINE_HTML_DIRECTIVE).toContain('Markdown 原生语法')
  })
  it('禁止整页框架', () => {
    expect(INLINE_HTML_DIRECTIVE).toContain('<!DOCTYPE>')
    expect(INLINE_HTML_DIRECTIVE).toContain('自包含的片段')
  })
  it('告诉模型配色会被接管,别在色值上花心思', () => {
    expect(INLINE_HTML_DIRECTIVE).toContain('配色不用纠结')
  })
  it('禁 class/id/style 标签(渲染端不会构造,提示词要与之一致)', () => {
    expect(INLINE_HTML_DIRECTIVE).toContain('禁止 <style> 标签、class 属性、id 属性')
  })
})
