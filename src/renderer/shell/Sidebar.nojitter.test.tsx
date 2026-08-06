import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import type { ChatSession } from '@shared/types'

// 侧栏「抖动」回归防线。
//
// 用户报的现象:从 A 工作区的会话切到 B 工作区的会话,左侧工作区列表明显在抖。两个独立成因,都是
// 「元素在某个状态下不渲染 / display:none」——它一进一出,同排的 .ws-meta(flex:1 1 auto) 就被迫重排:
//   ① 会话计数角标 .ws-scount 原本写作 `!isOn && …`:切换时旧行长出一枚 ~38px 角标、新行少一枚,
//      两行同时变形。
//   ② ⋯ 菜单 .ws-actions 原本用 display:none ↔ inline-flex:鼠标每划过一行就挤进 ~22px,
//      光是把指针移向下面的工作区,一路上的行都在抖。
// 两处都改成「常驻占位 + 视觉隐藏」(visibility / opacity),与同排的 .ws-grip/.ws-pin/.ws-newsess 一致。
//
// jsdom 不做布局,量不了像素;所以这里断言的是**成因**:这些元素在两种状态下都必须存在于 DOM,
// 且不能靠 display 来藏。这正是布局稳定的充分条件。

const WS_A = '/a'
const WS_B = '/b'

const sessionsA: ChatSession[] = [
  { id: 'a1', title: 'A 会话一', mode: 'chat', createdAt: 0 },
  { id: 'a2', title: 'A 会话二', mode: 'chat', createdAt: 1 },
]
const sessionsB: ChatSession[] = [
  { id: 'b1', title: 'B 会话一', mode: 'chat', createdAt: 0 },
  { id: 'b2', title: 'B 会话二', mode: 'chat', createdAt: 1 },
]

function renderSidebar(activeId: string) {
  return render(
    <Sidebar
      groups={[{ key: 'g', label: '最近', items: [
        { id: WS_A, name: '工作区 A', sub: '2 projects', status: 'wait' },
        { id: WS_B, name: '工作区 B', sub: '3 projects', status: 'wait' },
      ] }]}
      activeId={activeId}
      onSelect={() => {}}
      onNew={() => {}}
      onPin={() => {}}
      collapsed={false}
      sessions={activeId === WS_A ? sessionsA : sessionsB}
      activeSessionId={activeId === WS_A ? 'a1' : 'b2'}
      onSwitchSession={() => {}}
      onCloseSession={() => {}}
      onRenameSession={() => {}}
      onNewSession={() => {}}
      expandedIds={new Set([WS_A, WS_B])}
      sessionsByWs={{ [WS_A]: sessionsA, [WS_B]: sessionsB }}
    />
  )
}

const rowFor = (name: string): HTMLElement => {
  const el = [...document.querySelectorAll('.ws-item')]
    .find(n => n.querySelector('.ws-name-txt')?.textContent === name)
  if (!el) throw new Error(`找不到工作区行: ${name}`)
  return el as HTMLElement
}

describe('侧栏切换工作区不产生布局抖动', () => {
  it('会话计数角标在选中/未选中两种状态下都占位,只是视觉隐藏', () => {
    // A 选中时:A 的角标隐形但仍在 DOM;B 未选中,角标正常可见。
    const { unmount } = renderSidebar(WS_A)
    const aBadge = rowFor('工作区 A').querySelector('.ws-scount')
    const bBadge = rowFor('工作区 B').querySelector('.ws-scount')
    expect(aBadge).toBeTruthy()          // ← 关键:不是 `!isOn && …` 那种整个不渲染
    expect(bBadge).toBeTruthy()
    expect(aBadge!.className).toContain('ghost')
    expect(bBadge!.className).not.toContain('ghost')
    unmount()

    // 切到 B:两行的角标依然都在,只是 ghost 换了一边 —— 没有元素进出,布局不动。
    renderSidebar(WS_B)
    const aBadge2 = rowFor('工作区 A').querySelector('.ws-scount')
    const bBadge2 = rowFor('工作区 B').querySelector('.ws-scount')
    expect(aBadge2).toBeTruthy()
    expect(bBadge2).toBeTruthy()
    expect(aBadge2!.className).not.toContain('ghost')
    expect(bBadge2!.className).toContain('ghost')
  })

  it('⋯ 菜单容器常驻 DOM(靠 opacity 隐藏,不靠 display)', () => {
    renderSidebar(WS_A)
    // 两行都必须有 .ws-actions —— 它不该只在 hover 时才存在。
    expect(rowFor('工作区 A').querySelector('.ws-actions')).toBeTruthy()
    expect(rowFor('工作区 B').querySelector('.ws-actions')).toBeTruthy()
  })

  it('选中态本身不增删行内元素(除 ghost 标记外两行结构一致)', () => {
    // 结构性断言:同一个工作区在选中/未选中两种状态下,行内元素的类名序列必须一致。
    // 任何「选中才渲染 / 未选中才渲染」的分支都会让这条挂掉 —— 那正是抖动的来源。
    const skeleton = (row: HTMLElement) =>
      [...row.querySelectorAll('*')]
        .map(n => n.className)
        .filter((c): c is string => typeof c === 'string')
        .map(c => c.replace(/\bghost\b/, '').trim())
        .join('|')

    const { unmount } = renderSidebar(WS_A)
    const aWhenOn = skeleton(rowFor('工作区 A'))
    unmount()

    renderSidebar(WS_B)
    const aWhenOff = skeleton(rowFor('工作区 A'))
    expect(aWhenOff).toBe(aWhenOn)
  })
})
