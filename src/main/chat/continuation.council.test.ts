import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '@shared/types'
import type { CouncilStage } from '@shared/council'
import type { PersistedCouncil } from '../council/engine'
import { saveCouncil } from '../council/store'
import { appendMessage } from './chatStore'
import { buildLocalHistoryPreamble } from './continuation'
import { modelVisibleHistory } from './contextRebuild'
import { distillSession } from './memory/distiller'

let ws: string
const sid = 's-1'
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'cont-council-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

let n = 0
const normal = (who: 'user' | 'ai', text: string): ChatMessage => ({ id: `m${++n}`, who, text, ts: '' })
const cm = (cid: string, stage: CouncilStage, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `m${++n}`, who: 'ai', provider: 'codex', text, ts: '', council: { id: cid, stage, seat: 'A' }, ...extra })
const seat = { id: 'A', provider: 'codex', model: 'm', label: 'codex · A' }

function persist(id: string, chosen?: string) {
  const p: PersistedCouncil = {
    state: { id, workspacePath: ws, sessionId: sid, status: 'done', round: 1, totalRounds: 1, speaking: [], startedAt: 1, elapsedMs: 1, chosen,
      config: { topic: 't', attachments: [], seats: [seat, { ...seat, id: 'B' }], leader: seat, mode: { kind: 'rounds', rounds: 1 } } },
    transcript: { items: [], seen: {} }, failures: {}, dropped: [], phase: 'critique', spokenThisRound: [], resumes: 0,
  }
  saveCouncil(ws, p)
}

function seed(cid: string, withFinal = true) {
  appendMessage(ws, sid, cm(cid, 'topic', '议题TOPIC', { who: 'user' }))
  appendMessage(ws, sid, cm(cid, 'answer', '发言ANSWER'))
  appendMessage(ws, sid, cm(cid, 'summary', '总结SUMMARY'))
  if (withFinal) appendMessage(ws, sid, cm(cid, 'final', '最终正文FINALTEXT', { councilResult: { conclusion: '结论CONCLUSION', candidates: [], disagreements: [] } }))
}

describe('council context isolation', () => {
  it('keeps normal turns + final result line, drops transcript', () => {
    persist('c1', '方案甲')
    appendMessage(ws, sid, normal('user', '普通问题Q1'))
    seed('c1')
    appendMessage(ws, sid, normal('ai', '普通回答A2'))
    const p = buildLocalHistoryPreamble(ws, sid)
    expect(p).toContain('普通问题Q1')
    expect(p).toContain('普通回答A2')
    expect(p).toContain('【AI 共商结果】结论CONCLUSION(用户选定:方案甲)')
    for (const bad of ['议题TOPIC', '发言ANSWER', '总结SUMMARY', 'FINALTEXT']) expect(p).not.toContain(bad)
  })
  it('no chosen suffix when unchosen; falls back to message text without councilResult; caps 2000', () => {
    persist('c1')
    appendMessage(ws, sid, normal('user', 'Q'))
    appendMessage(ws, sid, cm('c1', 'final', 'x'.repeat(2500)))
    const p = buildLocalHistoryPreamble(ws, sid)
    expect(p).toContain('【AI 共商结果】' + 'x'.repeat(2000))
    expect(p).not.toContain('x'.repeat(2001))
    expect(p).not.toContain('用户选定')
  })
  it('fromIndex inside the council range yields only the result line (raw indices)', () => {
    persist('c1')
    appendMessage(ws, sid, normal('user', '普通问题Q1'))
    seed('c1') // raw idx 1..4
    const p = buildLocalHistoryPreamble(ws, sid, {}, { fromIndex: 2 })
    expect(p).toContain('结论CONCLUSION')
    for (const bad of ['普通问题Q1', 'ANSWER', 'SUMMARY']) expect(p).not.toContain(bad)
  })
  it('aborted council without final contributes nothing', () => {
    persist('c1')
    appendMessage(ws, sid, normal('user', 'Q1'))
    seed('c1', false)
    const p = buildLocalHistoryPreamble(ws, sid)
    expect(p).toContain('Q1')
    expect(p).not.toContain('ANSWER')
    expect(p).not.toContain('共商结果')
  })
  it('session distillation also excludes council transcript', async () => {
    persist('c1')
    appendMessage(ws, sid, normal('user', 'Q1'))
    seed('c1')
    let prompt = ''
    await distillSession(ws, sid, { oneShot: async (p) => { prompt = p; return 'ok' } })
    expect(prompt).toContain('Q1')
    expect(prompt).toContain('结论CONCLUSION')
    expect(prompt).not.toContain('ANSWER')
  })
  it('modelVisibleHistory (switch-summary / requirement-summary / conversation-doc input) excludes transcript', () => {
    persist('c1', '方案甲')
    appendMessage(ws, sid, normal('user', 'Q1'))
    seed('c1')
    const h = modelVisibleHistory(ws, sid)
    expect(h.map(m => m.text)).toEqual(['Q1', '【AI 共商结果】结论CONCLUSION(用户选定:方案甲)'])
  })
})
