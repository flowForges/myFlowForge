import { describe, it, expect } from 'vitest'
import type { DelegateBatch, SubagentCard } from '../../../src/shared/types'
import {
  delegateSummary,
  delegateTone,
  latestStep,
  subagentBody,
  subagentSummary,
  subagentTitle,
  subagentTone,
} from './agentParse'

const card = (o: Partial<SubagentCard>): SubagentCard => ({ id: 'a', state: 'done', ...o })

describe('subagentTitle', () => {
  it('类型 + 描述都在时两个都显示', () => {
    expect(subagentTitle(card({ subagentType: 'Explore', description: '找出所有权限门的入口' })))
      .toBe('Explore · 找出所有权限门的入口')
  })
  it('只有描述就用描述(模型自己起的名最贴切)', () => {
    expect(subagentTitle(card({ description: '跑测试' }))).toBe('跑测试')
  })
  it('只有类型就用类型', () => {
    expect(subagentTitle(card({ subagentType: 'general-purpose' }))).toBe('general-purpose')
  })
  it('都没有才退到「子代理」,不留空白', () => {
    expect(subagentTitle(card({}))).toBe('子代理')
    expect(subagentTitle(card({ description: '   ' }))).toBe('子代理')
  })
})

describe('subagentSummary', () => {
  it('★在跑的条数要单独说 —— 光说「3 个」看不出还有没有人在动', () => {
    const cards = [card({ state: 'running' }), card({ state: 'running' }), card({ state: 'done' })]
    expect(subagentSummary(cards)).toBe('3 个子代理 · 2 个在跑')
  })
  it('全跑完就只报总数', () => {
    expect(subagentSummary([card({}), card({})])).toBe('2 个子代理')
  })
  it('失败的也要报出来', () => {
    expect(subagentSummary([card({ state: 'error' }), card({})])).toBe('2 个子代理 · 1 个失败')
  })
})

const batch = (o: Partial<DelegateBatch>): DelegateBatch => ({
  runId: 'r', agents: [], done: false, task: 't', ...o,
})
const ag = (status: 'run' | 'ok' | 'idle') => ({ agentId: 'x' + status, name: 'p', provider: 'codex', status })

describe('delegateSummary', () => {
  it('在跑的单独说', () => {
    expect(delegateSummary(batch({ agents: [ag('run'), ag('ok')] }))).toBe('委派 · 2 个子代理 · 1 个在跑')
  })

  it('★`done` 只代表这一批派完了,不代表都成功', () => {
    // 三个里有一个 idle(= 失败/超时)。写成「全部完成」就是在报喜不报忧。
    const s = delegateSummary(batch({ agents: [ag('ok'), ag('idle'), ag('ok')], done: true }))
    expect(s).toContain('1 个没跑成')
    expect(s).not.toContain('都结束了')
  })

  it('真的全成功了才说都结束了', () => {
    expect(delegateSummary(batch({ agents: [ag('ok'), ag('ok')], done: true }))).toBe('委派 · 2 个子代理 · 都结束了')
  })

  it('★整批 done 了还有人挂在 run:说「没有回音」,不说「在跑」也不替它宣布成功', () => {
    // 那条终止的 progress 丢了(或者压根没发)。继续写「在跑」是在撒谎 —— 已经没有东西会来更新它了。
    const s = delegateSummary(batch({ agents: [ag('ok'), ag('run')], done: true }))
    expect(s).toBe('委派 · 2 个子代理 · 1 个没有回音')
    expect(s).not.toContain('在跑')
    expect(s).not.toContain('都结束了')
  })

  it('还没 done 也没人在跑时,不说「都结束了」', () => {
    expect(delegateSummary(batch({ agents: [ag('ok')], done: false }))).toBe('委派 · 1 个子代理')
  })
})

describe('状态色', () => {
  it('内置子代理:running/done/error', () => {
    expect(subagentTone('running')).toBe('run')
    expect(subagentTone('done')).toBe('ok')
    expect(subagentTone('error')).toBe('err')
  })
  it('★委派那边失败叫 idle 不叫 error —— 照 delegateRegistry 的名字翻', () => {
    expect(delegateTone('idle')).toBe('err')
    expect(delegateTone('run')).toBe('run')
    expect(delegateTone('ok')).toBe('ok')
  })
})

describe('latestStep', () => {
  it('取最近一步', () => {
    expect(latestStep(card({ steps: ['调用 Read a.ts', '调用 Bash: npm test'] }))).toBe('调用 Bash: npm test')
  })
  it('★一步都没有就返回空串 —— 界面据此不画那一行,而不是编一句「正在工作…」', () => {
    expect(latestStep(card({}))).toBe('')
    expect(latestStep(card({ steps: [] }))).toBe('')
  })
})

describe('subagentBody', () => {
  it('跑完了看结果', () => {
    expect(subagentBody(card({ state: 'done', result: '找到 3 处' }))).toEqual({ kind: 'result', text: '找到 3 处' })
  })

  it('还在跑就看最近几步(哪怕结果字段已经有半截)', () => {
    const b = subagentBody(card({ state: 'running', result: '半截', steps: ['一', '二'] }))
    expect(b).toEqual({ kind: 'steps', text: '一\n二' })
  })

  it('步数封顶,只留最近的几步', () => {
    const steps = ['1', '2', '3', '4', '5', '6', '7', '8']
    expect(subagentBody(card({ state: 'running', steps }), 3)).toEqual({ kind: 'steps', text: '6\n7\n8' })
  })

  it('★跑完了却什么都没有,要说清是「没回传」而不是「还在跑」', () => {
    expect(subagentBody(card({ state: 'done' }))).toEqual({ kind: 'none', text: '这个子代理没有回传内容' })
    expect(subagentBody(card({ state: 'running' }))).toEqual({ kind: 'none', text: '刚起来,还没有可显示的动作' })
  })

  it('失败的那张也走结果那条路(错误正文就在 result 里)', () => {
    expect(subagentBody(card({ state: 'error', result: '已取消' }))).toEqual({ kind: 'result', text: '已取消' })
  })
})
