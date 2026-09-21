import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { RelayUrlPicker } from './RelayUrlPicker'

/**
 * 用户原话(2026-09-21):「用户输入的,应该可以保存,然后下次可以下拉选择,也支持删除之前填写的,
 * 比如我有多个中转域名,就支持点击切换,还支持新增」。下面一条对应一个动作。
 */
const A = 'wss://relay.a.com'
const B = 'wss://relay.b.com'
const C = 'wss://c.workers.dev'

function setup(over: Partial<Parameters<typeof RelayUrlPicker>[0]> = {}) {
  const props = {
    current: A,
    history: [A, B, C],
    onSwitch: vi.fn(async () => {}),
    onRemember: vi.fn(async () => {}),
    onForget: vi.fn(async () => {}),
    ...over,
  }
  render(<RelayUrlPicker {...props} />)
  return props
}
const openIt = () => fireEvent.click(screen.getByRole('button', { name: '中转地址' }))
const options = () => screen.queryAllByRole('option').map((o) => o.textContent)

let confirmSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { confirmSpy.mockRestore() })

describe('RelayUrlPicker', () => {
  it('合上时显示正在用的地址', () => {
    setup()
    expect(screen.getByRole('button', { name: '中转地址' }).textContent).toContain(A)
    expect(options()).toEqual([])
  })

  /**
   * ★★09-17 那一版用的原生 datalist 会按输入框里的字过滤 —— 框里是当前地址时,别的一个都看不到。
   *  这里点开必须看到**全部**保存过的。
   */
  it('★点开列出全部保存过的地址,不按当前值过滤', () => {
    setup()
    openIt()
    expect(options()).toEqual([A, B, C])
    expect(screen.getByRole('option', { name: A }).getAttribute('aria-selected')).toBe('true')
  })

  it('★当前那条被挤出了历史(有上限)也照样列出来', () => {
    setup({ current: 'wss://old.one', history: [B] })
    openIt()
    expect(options()).toEqual(['wss://old.one', B])
  })

  it('点另一条:先确认(说清要重新扫码),确认后切换', async () => {
    const p = setup()
    openIt()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: B })) })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(String(confirmSpy.mock.calls[0]![0])).toMatch(/重新扫码/)
    expect(p.onSwitch).toHaveBeenCalledWith(B)
  })

  it('确认框点取消:不切换', async () => {
    confirmSpy.mockReturnValue(false)
    const p = setup()
    openIt()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: B })) })
    expect(p.onSwitch).not.toHaveBeenCalled()
  })

  it('点正在用的那条:什么都不做,也不弹确认', async () => {
    const p = setup()
    openIt()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: A })) })
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(p.onSwitch).not.toHaveBeenCalled()
  })

  it('× 删掉别的那条', async () => {
    const p = setup()
    openIt()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `删除 ${C}` })) })
    expect(p.onForget).toHaveBeenCalledWith(C)
  })

  /** ★删了正在用的那条,下拉里就看不到「现在连的是哪」,而中转照样连着 —— 界面和实际对不上。 */
  it('★正在用的那条的 × 是灰的', () => {
    setup()
    openIt()
    expect((screen.getByRole('button', { name: `删除 ${A}` }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: `删除 ${B}` }) as HTMLButtonElement).disabled).toBe(false)
  })

  /** ★新增 ≠ 切换:为了先存一个备用地址,不该把正连着的设备断掉。 */
  it('★新增:只存进单子,不切换', async () => {
    const p = setup()
    openIt()
    fireEvent.click(screen.getByRole('button', { name: '+ 新增地址' }))
    fireEvent.change(screen.getByLabelText('新的中转地址'), { target: { value: 'wss://new.relay/  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加' })) })
    expect(p.onRemember).toHaveBeenCalledWith('wss://new.relay')
    expect(p.onSwitch).not.toHaveBeenCalled()
  })

  it('一个地址都还没用过时,新增的直接用上(没有可断的,不弹确认)', async () => {
    const p = setup({ current: '', history: [] })
    openIt()
    expect(screen.getByText('还没有保存过中转地址')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '+ 新增地址' }))
    fireEvent.change(screen.getByLabelText('新的中转地址'), { target: { value: B } })
    await act(async () => { fireEvent.keyDown(screen.getByLabelText('新的中转地址'), { key: 'Enter' }) })
    expect(p.onSwitch).toHaveBeenCalledWith(B)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('新增时地址不像样:拦下来说清楚,不存', async () => {
    const p = setup()
    openIt()
    fireEvent.click(screen.getByRole('button', { name: '+ 新增地址' }))
    fireEvent.change(screen.getByLabelText('新的中转地址'), { target: { value: 'https://relay.x.com' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加' })) })
    expect(screen.getByRole('alert').textContent).toMatch(/ws:\/\/ 或 wss:\/\//)
    expect(p.onRemember).not.toHaveBeenCalled()
  })

  it('新增一个已经在单子里的:提示,不重复存', async () => {
    const p = setup()
    openIt()
    fireEvent.click(screen.getByRole('button', { name: '+ 新增地址' }))
    fireEvent.change(screen.getByLabelText('新的中转地址'), { target: { value: `${B}/` } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加' })) })
    expect(screen.getByRole('alert').textContent).toMatch(/已经在单子里/)
    expect(p.onRemember).not.toHaveBeenCalled()
  })

  /** ★主进程拒绝时(比如删正在用的那条)要把原因摆出来,不能点了没反应。 */
  it('主进程报错时把原因显示出来', async () => {
    const p = setup({ onForget: vi.fn(async () => { throw new Error("Error invoking remote method 'relay:forget-url': Error: 正在用的中转地址不能删") }) })
    openIt()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `删除 ${C}` })) })
    expect(p.onForget).toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('正在用的中转地址不能删')
  })
})
