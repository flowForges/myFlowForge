import { describe, it, expect } from 'vitest'
import { buildPush, pushKey, NEEDS_YOU, type PushKind } from './message'

const ALL: PushKind[] = ['confirm', 'ask', 'gate', 'question', 'done']

describe('buildPush', () => {
  it('标题带工作区名和类别', () => {
    const m = buildPush({ kind: 'confirm', target: { workspacePath: '/ws' }, workspaceName: 'my-app' })
    expect(m.title).toBe('my-app · 需要你确认')
  })

  it('没有工作区名时退回 app 名,不留一个悬空的分隔点', () => {
    const m = buildPush({ kind: 'done', target: { workspacePath: '/ws' } })
    expect(m.title).toBe('myFlowForge · 跑完了')
    expect(m.title).not.toContain(' · ·')
  })

  it('工作区名只有空格时按没有处理', () => {
    expect(buildPush({ kind: 'done', target: { workspacePath: '/ws' }, workspaceName: '   ' }).title)
      .toBe('myFlowForge · 跑完了')
  })

  it('超长工作区名截断并收尾', () => {
    const m = buildPush({ kind: 'done', target: { workspacePath: '/ws' }, workspaceName: 'x'.repeat(200) })
    expect(m.title.length).toBe(60)
    expect(m.title.endsWith('…')).toBe(true)
  })

  it('每一种都有自己的标题和正文,不许撞车', () => {
    const titles = new Set<string>()
    const bodies = new Set<string>()
    for (const kind of ALL) {
      const m = buildPush({ kind, target: { workspacePath: '/ws' }, workspaceName: 'w' })
      expect(m.title).toBeTruthy()
      expect(m.body).toBeTruthy()
      titles.add(m.title)
      bodies.add(m.body)
    }
    expect(titles.size).toBe(ALL.length)
    expect(bodies.size).toBe(ALL.length)
  })

  it('data 带够路由信息', () => {
    const m = buildPush({ kind: 'ask', target: { workspacePath: '/ws', sessionId: 's1' } })
    expect(m.data).toEqual({ wsPath: '/ws', sessionId: 's1', kind: 'ask' })
  })

  it('工作区级的事 sessionId 落成 null(不是 undefined —— 它要过 JSON)', () => {
    const m = buildPush({ kind: 'gate', target: { workspacePath: '/ws' } })
    expect(m.data.sessionId).toBeNull()
    expect(JSON.parse(JSON.stringify(m.data)).sessionId).toBeNull()
  })

  it('★正文里不含任何调用方给的自由文本 —— 签名里就没有放它的地方', () => {
    // 这条是拿类型之外的方式再钉一次:哪怕以后有人往 PushEvent 上挂了个 text 字段,
    // 只要 buildPush 不去读它,这条就还是绿的;而一旦有人把它拼进 body,这条立刻红。
    const evil = { kind: 'confirm' as const, target: { workspacePath: '/ws' }, workspaceName: 'w', text: '删掉整个数据库?' }
    const m = buildPush(evil as never)
    expect(m.title + m.body).not.toContain('删掉整个数据库')
  })

  it('NEEDS_YOU 分组:门是门,跑完了不是门', () => {
    expect([...NEEDS_YOU].sort()).toEqual(['ask', 'confirm', 'gate', 'question'])
    expect(NEEDS_YOU.has('done')).toBe(false)
  })
})

describe('pushKey', () => {
  it('有 eventId 就按它去重', () => {
    const a = pushKey({ kind: 'gate', target: { workspacePath: '/ws' }, eventId: 'g1' })
    const b = pushKey({ kind: 'gate', target: { workspacePath: '/other' }, eventId: 'g1' })
    expect(a).toBe(b)
  })

  it('没有 eventId 时按 工作区+会话+类别 去重', () => {
    const t = { workspacePath: '/ws', sessionId: 's1' }
    expect(pushKey({ kind: 'done', target: t })).toBe(pushKey({ kind: 'done', target: t }))
    expect(pushKey({ kind: 'done', target: t })).not.toBe(pushKey({ kind: 'done', target: { workspacePath: '/ws', sessionId: 's2' } }))
  })

  it('类别不同不许撞成同一个键', () => {
    const t = { workspacePath: '/ws' }
    expect(pushKey({ kind: 'confirm', target: t, eventId: 'x' })).not.toBe(pushKey({ kind: 'ask', target: t, eventId: 'x' }))
  })
})
