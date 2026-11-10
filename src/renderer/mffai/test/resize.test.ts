import { describe, it, expect, afterEach } from 'vitest'
import { installResize } from './resize'

describe('test/resize', () => {
  let uninstall: (() => void) | undefined
  afterEach(() => { uninstall?.(); uninstall = undefined; document.body.innerHTML = '' })

  it('an observer on .mffai-main receives setMainWidth; others do not; uninstall restores', () => {
    const before = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    const r = installResize()
    uninstall = r.uninstall
    const main = document.createElement('div')
    main.className = 'mffai-main'
    const other = document.createElement('div')
    document.body.append(main, other)
    const got: number[] = [], gotOther: number[] = []
    const ro = new ResizeObserver((entries) => { for (const e of entries) got.push(e.contentRect.width) })
    const ro2 = new ResizeObserver((entries) => { for (const e of entries) gotOther.push(e.contentRect.width) })
    ro.observe(main)
    ro2.observe(other)
    r.setMainWidth(1100)
    expect(got).toEqual([1100])
    expect(gotOther).toEqual([])
    // 之后才 observe 的拿到当前宽度
    const late: number[] = []
    new ResizeObserver((entries) => { for (const e of entries) late.push(e.borderBoxSize[0].inlineSize) }).observe(main)
    expect(late).toEqual([1100])
    r.setMainWidth(undefined)
    expect(got).toEqual([1100, 0])
    ro.disconnect()
    r.setMainWidth(1440)
    expect(got).toEqual([1100, 0])
    r.uninstall()
    uninstall = undefined
    expect((globalThis as { ResizeObserver?: unknown }).ResizeObserver).toBe(before)
  })
})
