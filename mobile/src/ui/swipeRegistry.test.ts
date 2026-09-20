import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claimSwipeOpen, closeOpenSwipe, releaseSwipeOpen, resetSwipeRegistry } from './swipeRegistry'

const handle = () => {
  const close = vi.fn()
  return { h: { close }, close }
}

describe('swipeRegistry', () => {
  beforeEach(() => resetSwipeRegistry())

  it('★滑开第二行时第一行自己收起来', () => {
    const a = handle()
    const b = handle()
    claimSwipeOpen(a.h)
    claimSwipeOpen(b.h)
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(b.close).not.toHaveBeenCalled()
  })

  it('★顶掉上一行之后,注册表里是新那一行(closeOpenSwipe 收的必须是 b 不是 a)', () => {
    const a = handle()
    const b = handle()
    claimSwipeOpen(a.h)
    claimSwipeOpen(b.h)
    // b 才是现在开着的那个;closeOpenSwipe 必须收 b。
    expect(closeOpenSwipe()).toBe(true)
    expect(b.close).toHaveBeenCalledTimes(1)
    expect(a.close).toHaveBeenCalledTimes(1) // 还是刚才被顶掉那一次,没有第二次
  })

  it('同一行重复 claim 不会把自己收掉', () => {
    const a = handle()
    claimSwipeOpen(a.h)
    claimSwipeOpen(a.h)
    expect(a.close).not.toHaveBeenCalled()
  })

  it('★没有开着的行时,closeOpenSwipe 回 false —— 点击不该被凭空吃掉', () => {
    expect(closeOpenSwipe()).toBe(false)
  })

  it('closeOpenSwipe 之后注册表是空的,连点两下第二下不再被吃掉', () => {
    const a = handle()
    claimSwipeOpen(a.h)
    expect(closeOpenSwipe()).toBe(true)
    expect(closeOpenSwipe()).toBe(false)
    expect(a.close).toHaveBeenCalledTimes(1)
  })

  it('自己收起来之后就不再是「开着的那一行」', () => {
    const a = handle()
    claimSwipeOpen(a.h)
    releaseSwipeOpen(a.h)
    expect(closeOpenSwipe()).toBe(false)
  })

  it('★A 的 release 迟到时不许把 B 抹掉(两套动画回调不保证交错顺序)', () => {
    const a = handle()
    const b = handle()
    claimSwipeOpen(a.h)
    claimSwipeOpen(b.h) // a 被顶掉
    releaseSwipeOpen(a.h) // a 那次收起的回调此刻才到
    expect(closeOpenSwipe()).toBe(true) // B 还在注册表里
    expect(b.close).toHaveBeenCalledTimes(1)
  })
})
