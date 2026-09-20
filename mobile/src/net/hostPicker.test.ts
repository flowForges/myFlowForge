import { describe, expect, it } from 'vitest'
import { hostPickRows } from './hostPicker'
import type { MobileHost } from './hosts'
import type { HostState } from './hostClient'

const host = (id: string, over: Partial<MobileHost> = {}): MobileHost => ({
  id,
  label: `主机 ${id}`,
  url: `ws://10.0.0.${id}:6789`,
  token: '',
  icon: '🖥️',
  lastConnectedAt: 0,
  ...over,
})

const ready: HostState = { status: 'ready', version: '1.2.0', methods: new Set(['a']) }

describe('hostPickRows', () => {
  it('门数只属于连着的那一台,其余是 null 而不是 0', () => {
    const rows = hostPickRows([host('1'), host('2')], '1', ready, 3)
    expect(rows[0].gates).toBe(3)
    // ★这一条是整个模块的理由:写 0 就是替一台没连上的机器说「它上面没事」。
    //  用 `toBeNull` 而不是 `toBeFalsy` —— 0 也是 falsy,那样这条断言会对着 0 变绿。
    expect(rows[1].gates).toBeNull()
  })

  it('连着的那一台真没门时是 0(知道且为零),不是 null', () => {
    const rows = hostPickRows([host('1')], '1', ready, 0)
    expect(rows[0].gates).toBe(0)
  })

  it('没选任何主机时,一台都不报门数', () => {
    const rows = hostPickRows([host('1'), host('2')], null, null, 5)
    expect(rows.map((r) => r.gates)).toEqual([null, null])
    expect(rows.every((r) => !r.active)).toBe(true)
  })

  it('连接状态只挂在当前这台身上', () => {
    const rows = hostPickRows([host('1'), host('2')], '2', ready, 0)
    expect(rows[1].active).toBe(true)
    expect(rows[1].tone).toBe('ok')
    expect(rows[1].status).toBe('已连接 · 1.2.0')
    // 不是当前这台:没有状态可言。写「未连接」会让人以为它刚断线。
    expect(rows[0].tone).toBeNull()
    expect(rows[0].status).toBeNull()
  })

  it('副行:当前这台带版本,其余只有地址', () => {
    const rows = hostPickRows([host('1'), host('2')], '1', ready, 0)
    expect(rows[0].sub).toBe('10.0.0.1:6789 · 1.2.0')
    expect(rows[1].sub).toBe('10.0.0.2:6789')
  })

  it('当前这台断着的时候,副行报的是原因不是地址', () => {
    const failed: HostState = { status: 'failed', error: '令牌不对' }
    const rows = hostPickRows([host('1')], '1', failed, 0)
    expect(rows[0].sub).toBe('连接失败:令牌不对')
    expect(rows[0].tone).toBe('off')
  })

  it('保持原序,不把当前这台提到最前', () => {
    const rows = hostPickRows([host('1'), host('2'), host('3')], '3', ready, 0)
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '3'])
  })
})
