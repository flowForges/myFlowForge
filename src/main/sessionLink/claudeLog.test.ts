import { describe, it, expect } from 'vitest'
import { writeFileSync, statSync } from 'node:fs'
import { readExternal } from './index'
import { jsonl, tempFile, append, claudeTurnRows, claudeUser, claudeAssistant, claudeToolResult, claudeStopHook } from './testFixtures'

describe('readExternal claude', () => {
  it('parses user / assistant / folded tool turns, skips meta + noise + tool_result, reports cwd', async () => {
    const f = tempFile('s.jsonl', jsonl(claudeTurnRows()))
    const r = await readExternal('claude', f, { offset: 0 })
    expect(r.reset).toBe(false)
    expect(r.turns.map(t => [t.who, t.text])).toEqual([
      ['user', '帮我重构登录流程'],
      ['tool', 'Bash ls -la src'],
      ['assistant', '好的,这是方案'],
    ])
    expect(r.turns[0].id).toBe('u1')
    expect(r.turns[0].ts).toBe(Date.parse('2026-06-01T00:01:00.000Z'))
    expect(new Set(r.turns.map(t => t.id)).size).toBe(3)
    expect(r.cwd).toBe('/Users/me/proj')
    expect(r.next.offset).toBe(statSync(f).size)
    expect(r.next.lastId).toBeTruthy()
    expect(r.endedCleanly).toBe(true)
  })

  it('incremental: only new turns after the cursor, no duplicates', async () => {
    const f = tempFile('s.jsonl', jsonl(claudeTurnRows()))
    const a = await readExternal('claude', f, { offset: 0 })
    const same = await readExternal('claude', f, a.next)
    expect(same.turns).toEqual([])
    expect(same.reset).toBe(false)
    expect(same.endedCleanly).toBe(true)    // 没有新行 → 往回看尾部
    append(f, jsonl([claudeUser('u2', '再加个测试')]))
    const b = await readExternal('claude', f, a.next)
    expect(b.turns.map(t => t.text)).toEqual(['再加个测试'])
    expect(b.endedCleanly).toBe(false)      // 用户刚发,还没回
  })

  it('half-written last line is not consumed; picked up next time', async () => {
    const full = JSON.stringify(claudeUser('u2', '半行消息'))
    const f = tempFile('s.jsonl', jsonl(claudeTurnRows()) + full.slice(0, 20))
    const a = await readExternal('claude', f, { offset: 0 })
    expect(a.turns.map(t => t.text)).not.toContain('半行消息')
    expect(a.next.offset).toBe(statSync(f).size - 20)
    expect(a.endedCleanly).toBe(false)      // 有人正写到一半
    append(f, full.slice(20) + '\n')
    const b = await readExternal('claude', f, a.next)
    expect(b.reset).toBe(false)
    expect(b.turns.map(t => t.text)).toEqual(['半行消息'])
  })

  it('truncated file → reset:true and full re-read, no crash', async () => {
    const f = tempFile('s.jsonl', jsonl(claudeTurnRows()))
    const a = await readExternal('claude', f, { offset: 0 })
    writeFileSync(f, jsonl([claudeUser('x1', '新开头')]))
    const b = await readExternal('claude', f, a.next)
    expect(b.reset).toBe(true)
    expect(b.turns.map(t => t.text)).toEqual(['新开头'])
  })

  it('rewritten file of equal-or-longer size whose last consumed line changed → reset:true', async () => {
    const f = tempFile('s.jsonl', jsonl([claudeUser('u1', 'aaaa')]))
    const a = await readExternal('claude', f, { offset: 0 })
    writeFileSync(f, jsonl([claudeUser('u1', 'bbbb'), claudeUser('u2', 'cccc')]))
    const b = await readExternal('claude', f, a.next)
    expect(b.reset).toBe(true)
    expect(b.turns.map(t => t.text)).toEqual(['bbbb', 'cccc'])
  })

  it('offset not on a line boundary (no lastId) → reset', async () => {
    const f = tempFile('s.jsonl', jsonl(claudeTurnRows()))
    const b = await readExternal('claude', f, { offset: 5 })
    expect(b.reset).toBe(true)
    expect(b.turns.length).toBe(3)
  })

  it('missing file → empty, exists:false, no throw', async () => {
    const r = await readExternal('claude', '/nonexistent/dir/x.jsonl', { offset: 10, lastId: 'z' })
    expect(r.exists).toBe(false)
    expect(r.turns).toEqual([])
    expect(r.endedCleanly).toBe(false)
  })

  describe('end marker', () => {
    const ended = async (rows: unknown[]) => (await readExternal('claude', tempFile('e.jsonl', jsonl(rows)), { offset: 0 })).endedCleanly
    it('assistant with a pending tool_use → not ended', async () => {
      expect(await ended([claudeUser('u', 'q'), claudeAssistant('a', [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a' } }], 'tool_use')])).toBe(false)
    })
    it('tool_result awaiting the model → not ended', async () => {
      expect(await ended([claudeUser('u', 'q'), claudeAssistant('a', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }], 'tool_use'), claudeToolResult('r', 't')])).toBe(false)
    })
    it('final assistant text (end_turn) → ended, trailing bookkeeping lines ignored', async () => {
      expect(await ended([claudeUser('u', 'q'), claudeAssistant('a', [{ type: 'text', text: 'done' }]), { type: 'last-prompt' }, { type: 'attachment' }])).toBe(true)
    })
    it('stop_hook_summary / result → ended', async () => {
      expect(await ended([claudeUser('u', 'q'), claudeStopHook('s')])).toBe(true)
      expect(await ended([claudeUser('u', 'q'), { type: 'result', subtype: 'success' }])).toBe(true)
    })
    it('api_error retry in progress → not ended', async () => {
      expect(await ended([claudeUser('u', 'q'), { type: 'system', subtype: 'api_error', uuid: 'e' }])).toBe(false)
    })
    it('user interrupt → ended', async () => {
      expect(await ended([claudeUser('u', 'q'), claudeUser('i', '[Request interrupted by user]')])).toBe(true)
    })
  })

  it('streams in small chunks across multibyte chars and long lines identically', async () => {
    const big = 'x'.repeat(5000) + '中文'
    const rows = [...claudeTurnRows(), claudeUser('u9', big)]
    const f = tempFile('s.jsonl', jsonl(rows))
    const whole = await readExternal('claude', f, { offset: 0 })
    const tiny = await readExternal('claude', f, { offset: 0 }, { chunkSize: 7 })
    expect(tiny.turns).toEqual(whole.turns)
    expect(tiny.next).toEqual(whole.next)
    expect(tiny.turns.at(-1)!.text).toBe(big)
  })

  it('tail scan for endedCleanly works with small chunks across a long tail', async () => {
    const rows = [claudeUser('u', 'q'), claudeAssistant('a', [{ type: 'text', text: 'done' }]), ...Array.from({ length: 50 }, () => ({ type: 'attachment', blob: 'y'.repeat(200) }))]
    const f = tempFile('s.jsonl', jsonl(rows))
    const a = await readExternal('claude', f, { offset: 0 })
    const b = await readExternal('claude', f, a.next, { chunkSize: 13 })
    expect(b.turns).toEqual([])
    expect(b.endedCleanly).toBe(true)
  })
})
