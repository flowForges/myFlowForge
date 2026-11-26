import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { readExternal } from './index'
import { jsonl, tempFile, append, codexTurnRows, codexMeta, codexMsg, codexEvent } from './testFixtures'

describe('readExternal codex', () => {
  it('parses user / assistant / folded tool turns; drops developer + injected context; cwd from latest turn_context', async () => {
    const f = tempFile('rollout-x.jsonl', jsonl(codexTurnRows()))
    const r = await readExternal('codex', f, { offset: 0 })
    expect(r.turns.map(t => [t.who, t.text])).toEqual([
      ['user', '修复构建错误'],
      ['tool', 'shell bash -lc npm run build'],
      ['assistant', '已修复'],
    ])
    expect(r.turns[0].id).toBe('m1')
    expect(r.cwd).toBe('/Users/me/work2')
    expect(r.endedCleanly).toBe(true)
  })

  it('cwd from session_meta when no turn_context', async () => {
    const f = tempFile('rollout-x.jsonl', jsonl([codexMeta('/a/b'), codexMsg('user', 'hi')]))
    expect((await readExternal('codex', f, { offset: 0 })).cwd).toBe('/a/b')
  })

  it('end markers: task_complete / turn_aborted end; task_started / response items mean in progress', async () => {
    const ended = async (rows: unknown[]) => (await readExternal('codex', tempFile('r.jsonl', jsonl(rows)), { offset: 0 })).endedCleanly
    expect(await ended([codexMeta(), codexEvent('task_started'), codexMsg('user', 'q')])).toBe(false)
    expect(await ended([codexMeta(), codexMsg('user', 'q'), codexMsg('assistant', 'a'), codexEvent('token_count')])).toBe(false)
    expect(await ended([codexMeta(), codexMsg('user', 'q'), codexEvent('turn_aborted')])).toBe(true)
    expect(await ended([codexMeta(), codexMsg('user', 'q'), codexEvent('task_complete'), codexEvent('token_count')])).toBe(true)
    expect(await ended([codexMeta()])).toBe(false)
  })

  it('incremental + half line + truncation', async () => {
    const f = tempFile('rollout-x.jsonl', jsonl(codexTurnRows()))
    const a = await readExternal('codex', f, { offset: 0 })
    const line = JSON.stringify(codexMsg('user', '第二轮', 'm3'))
    append(f, line.slice(0, 30))
    const b = await readExternal('codex', f, a.next)
    expect(b.turns).toEqual([])
    expect(b.next.offset).toBe(a.next.offset)
    expect(b.endedCleanly).toBe(false)
    append(f, line.slice(30) + '\n')
    const c = await readExternal('codex', f, b.next)
    expect(c.turns.map(t => t.text)).toEqual(['第二轮'])
    expect(c.cwd).toBeUndefined()           // cwd 只在读到的范围里出现时才给
    writeFileSync(f, jsonl([codexMeta('/z'), codexMsg('user', 'only')]))
    const d = await readExternal('codex', f, c.next)
    expect(d.reset).toBe(true)
    expect(d.turns.map(t => t.text)).toEqual(['only'])
    expect(d.cwd).toBe('/z')
  })
})
