import { describe, it, expect } from 'vitest'
import { createRunFenceScanner } from './runFence'

function scan(lines: string[]) {
  const tasks: string[] = []
  const scanner = createRunFenceScanner((t) => tasks.push(t))
  const out: string[] = []
  for (const l of lines) out.push(...scanner.feedLine(l))
  out.push(...scanner.flush())
  return { out, tasks }
}

describe('runFence', () => {
  it('extracts task, strips the fence, passes surrounding lines through', () => {
    const { out, tasks } = scan(['好的，开始开发。', '```forge:run', '{"task":"实现登录"}', '```', '已启动。'])
    expect(out).toEqual(['好的，开始开发。', '已启动。'])
    expect(tasks).toEqual(['实现登录'])
  })

  it('fail-safe on bad JSON: no trigger, lines returned verbatim', () => {
    const { out, tasks } = scan(['```forge:run', 'NOT JSON', '```'])
    expect(tasks).toEqual([])
    expect(out).toEqual(['```forge:run', 'NOT JSON', '```'])
  })

  it('fail-safe on missing/empty task: no trigger, verbatim', () => {
    const { out, tasks } = scan(['```forge:run', '{"foo":1}', '```'])
    expect(tasks).toEqual([])
    expect(out).toEqual(['```forge:run', '{"foo":1}', '```'])
  })

  it('does not trigger on prose merely mentioning forge:run', () => {
    const { out, tasks } = scan(['我会输出一个 forge:run 块来触发。'])
    expect(tasks).toEqual([])
    expect(out).toEqual(['我会输出一个 forge:run 块来触发。'])
  })

  it('drains an unclosed fence past the cap (fail-safe, no swallow)', () => {
    const lines = ['```forge:run', ...Array.from({ length: 70 }, (_, i) => `line ${i}`)]
    const { out, tasks } = scan(lines)
    expect(tasks).toEqual([])
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]).toBe('```forge:run')
  })
})
