import { describe, it, expect } from 'vitest'
import { renderSnapshot } from './cuSnapshotRender'
import type { SnapshotResult, SnapNodeWire } from './computerUse'

/** spec §8.2 example tree: four depth-0 nodes under a window called "WorkBuddy". */
const SPEC_NODES: SnapNodeWire[] = [
  { ref: 'e4', depth: 0, role: 'button', name: '新建会话', states: [], actions: ['click'] },
  { ref: 'e5', depth: 0, role: 'list', name: '会话', states: ['collapsed'], actions: [], childrenCount: 24 },
  { ref: 'e9', depth: 0, role: 'textfield', name: '输入消息', value: '', states: [], actions: ['type', 'focus'] },
  { ref: 'e10', depth: 0, role: 'button', name: '发送', states: ['disabled'], actions: ['click'] },
]

function result(nodes: SnapNodeWire[], over: Partial<SnapshotResult> = {}): SnapshotResult {
  return {
    snapId: 's3',
    instance: { pid: 1, start: '1.0' },
    app: { bundleId: 'com.example.workbuddy', name: 'WorkBuddy' },
    window: { number: 1, title: 'WorkBuddy' },
    complete: true,
    nodes,
    ...over,
  }
}

describe('renderSnapshot (spec §8.2)', () => {
  it('renders the spec example node-for-node', () => {
    expect(renderSnapshot(result(SPEC_NODES))).toBe(
      [
        '窗口「WorkBuddy」 complete',
        '- button "新建会话" @s3:e4 [click]',
        '- list "会话" @s3:e5 (24 项, 已折叠 → root=@s3:e5)',
        '- textfield "输入消息" @s3:e9 [type,focus] 值=""',
        '- button "发送" @s3:e10 [click] 禁用',
      ].join('\n'),
    )
  })

  it('incomplete snapshots say so on the first line', () => {
    const out = renderSnapshot(result(SPEC_NODES, { complete: false }))
    expect(out.startsWith('窗口「WorkBuddy」 incomplete\n')).toBe(true)
  })

  it('indents by 2 spaces per depth level', () => {
    const nodes: SnapNodeWire[] = [
      { ref: 'e1', depth: 0, role: 'group', name: '容器', states: [], actions: [] },
      { ref: 'e2', depth: 1, role: 'button', name: '子按钮', states: [], actions: ['click'] },
      { ref: 'e3', depth: 2, role: 'button', name: '孙按钮', states: [], actions: ['click'] },
    ]
    const lines = renderSnapshot(result(nodes)).split('\n')
    expect(lines[1]).toBe('- group "容器" @s3:e1')
    expect(lines[2]).toBe('  - button "子按钮" @s3:e2 [click]')
    expect(lines[3]).toBe('    - button "孙按钮" @s3:e3 [click]')
  })

  it('maps every state word the spec lists, and the boolean offscreen field', () => {
    const nodes: SnapNodeWire[] = [
      { ref: 'e1', depth: 0, role: 'textfield', name: 'a', states: ['focused'], actions: [] },
      { ref: 'e2', depth: 0, role: 'row', name: 'b', states: ['selected'], actions: [] },
      { ref: 'e3', depth: 0, role: 'checkbox', name: 'c', states: ['checked'], actions: [] },
      { ref: 'e4', depth: 0, role: 'combobox', name: 'd', states: ['expanded'], actions: [] },
      { ref: 'e5', depth: 0, role: 'button', name: 'e', states: [], actions: [], offscreen: true },
    ]
    const lines = renderSnapshot(result(nodes)).split('\n').slice(1)
    expect(lines[0]).toBe('- textfield "a" @s3:e1 焦点')
    expect(lines[1]).toBe('- row "b" @s3:e2 已选中')
    expect(lines[2]).toBe('- checkbox "c" @s3:e3 已勾选')
    expect(lines[3]).toBe('- combobox "d" @s3:e4 已展开')
    expect(lines[4]).toBe('- button "e" @s3:e5 屏幕外')
  })

  it('caps at 18000 characters and ends with the drill-down marker', () => {
    const nodes: SnapNodeWire[] = Array.from({ length: 5000 }, (_, i) => ({
      ref: `e${i}`, depth: 0, role: 'button', name: `按钮 ${i}`, states: [], actions: ['click'],
    }))
    const out = renderSnapshot(result(nodes))
    expect(out.length).toBeLessThanOrEqual(18000)
    const lines = out.split('\n')
    expect(lines[lines.length - 1]).toBe('已截断 · 用 root 钻取')
  })

  it('escapes a quote in a name as \\"', () => {
    const nodes: SnapNodeWire[] = [{ ref: 'e1', depth: 0, role: 'button', name: '说"你好"', states: [], actions: ['click'] }]
    const lines = renderSnapshot(result(nodes)).split('\n')
    expect(lines[1]).toBe('- button "说\\"你好\\"" @s3:e1 [click]')
  })

  it('a node without a ref omits it, and a node without a name omits the quoted name', () => {
    const nodes: SnapNodeWire[] = [{ depth: 0, role: 'group', states: [], actions: [] }]
    const lines = renderSnapshot(result(nodes)).split('\n')
    expect(lines[1]).toBe('- group')
  })
})
