import { describe, it, expect } from 'vitest'
import { canPeekGate } from './gatePeek'

const confirmIn = (wsPath: string) => ({ kind: 'confirm', wsPath })

describe('👁 看看 摆不摆', () => {
  it('本会话所在工作区的 confirm 门 → 摆', () => {
    expect(canPeekGate(confirmIn('/w1'), '/w1')).toBe(true)
  })

  it('★借来的门(别的工作区)→ 不摆:那一屏拉的是 /w1 的 diff,拿它给 /w2 的门当依据是错的', () => {
    expect(canPeekGate(confirmIn('/w2'), '/w1')).toBe(false)
  })

  it('同一个区、别的会话的门 → 照样摆:变更是工作区级的,那份 diff 仍是对的依据', () => {
    // 这条钉住的是「别顺手收紧成 myGates」:收紧了会让同区另一条会话的门无谓地少一个入口。
    expect(canPeekGate(confirmIn('/w1'), '/w1')).toBe(true)
  })

  it('前缀相同但不是同一个区 → 不摆(/w1 和 /w10 是两个区)', () => {
    expect(canPeekGate(confirmIn('/w10'), '/w1')).toBe(false)
  })

  it('选择题门不摆 —— 它问的是「选哪个方案」,diff 帮不上忙', () => {
    expect(canPeekGate({ kind: 'questions', wsPath: '/w1' }, '/w1')).toBe(false)
    expect(canPeekGate({ kind: 'ask', wsPath: '/w1' }, '/w1')).toBe(false)
  })

  it('没选中任何会话时不摆 —— 变更页没有 wsPath 可拉,推过去是个空屏', () => {
    expect(canPeekGate(confirmIn('/w1'), null)).toBe(false)
    expect(canPeekGate(confirmIn('/w1'), undefined)).toBe(false)
    expect(canPeekGate(confirmIn('/w1'), '')).toBe(false)
  })

  it('★两边都是空串也不摆 —— 光靠 `===` 挡不住这一档,必须有那句 `if (!viewingWsPath)`', () => {
    // 空的 `viewing` 不是假想:切主机那一瞬客户端的 viewing 就是两个空串
    // (`reportSeen.ts` 里记着同一件事)。那一刻变更页没有任何东西可拉,
    // 而 `'' === ''` 是**真**—— 只比不判空的话,这一档会摆出一颗推进空屏的按钮。
    expect(canPeekGate({ kind: 'confirm', wsPath: '' }, '')).toBe(false)
  })

  it('没有门时不摆', () => {
    expect(canPeekGate(null, '/w1')).toBe(false)
    expect(canPeekGate(undefined, '/w1')).toBe(false)
  })
})
