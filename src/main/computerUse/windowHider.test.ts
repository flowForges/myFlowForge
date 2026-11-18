import { describe, it, expect, vi } from 'vitest'
import type { Instance } from '@shared/computerUse'
import { createWindowHider, type HideableWin } from './windowHider'

const T: Instance = { pid: 500, start: '1.2' }

function win(id: number, o: { visible?: boolean; isPet?: boolean } = {}) {
  let visible = o.visible ?? true
  const w = {
    id, isPet: o.isPet ?? false,
    isVisible: () => visible,
    hide: vi.fn(() => { visible = false }),
    showInactive: vi.fn(() => { visible = true }),
    userShow: () => { visible = true },
  }
  return w
}

function setup(o: { front?: boolean[]; live?: () => boolean } = {}) {
  const main = win(1)
  const other = win(2)
  const hiddenAlready = win(3, { visible: false })
  const pet = win(4, { isPet: true })
  const wins: ReturnType<typeof win>[] = [main, other, hiddenAlready, pet]
  const fronts = [...(o.front ?? [false])]
  const isOwnAppFront = vi.fn(async () => (fronts.length > 1 ? fronts.shift()! : fronts[0]))
  const activateAway = vi.fn(async (_t?: Instance) => {})
  const h = createWindowHider({ windows: () => wins as HideableWin[], isOwnAppFront, activateAway, ...(o.live ? { live: o.live } : {}) })
  return { h, main, other, hiddenAlready, pet, wins, isOwnAppFront, activateAway }
}

describe('createWindowHider (spec §9.1, §9.3)', () => {
  it('first beforeMutation hides every visible non-pet window; a second one in the same turn hides nothing more', async () => {
    const t = setup()
    t.h.turnStarted()
    await t.h.beforeMutation(T)
    expect(t.main.hide).toHaveBeenCalledTimes(1)
    expect(t.other.hide).toHaveBeenCalledTimes(1)
    expect(t.hiddenAlready.hide).not.toHaveBeenCalled()
    expect(t.pet.hide).not.toHaveBeenCalled()
    t.main.userShow() // shown by something else, not a user show we were told about
    await t.h.beforeMutation(T)
    expect(t.main.hide).toHaveBeenCalledTimes(1)
    expect(t.other.hide).toHaveBeenCalledTimes(1)
  })

  it('still the front app after hiding → activateAway(target); not front → no activateAway', async () => {
    const t = setup({ front: [true] })
    await t.h.beforeMutation(T)
    expect(t.activateAway).toHaveBeenCalledTimes(1)
    expect(t.activateAway).toHaveBeenCalledWith(T)
    const u = setup({ front: [false] })
    await u.h.beforeMutation(T)
    expect(u.activateAway).not.toHaveBeenCalled()
  })

  it('the front check runs after the windows are hidden', async () => {
    const t = setup({ front: [true] })
    t.isOwnAppFront.mockImplementation(async () => { expect(t.main.hide).toHaveBeenCalled(); return false })
    await t.h.beforeMutation(T)
    expect(t.isOwnAppFront).toHaveBeenCalled()
  })

  it('without a target it still hides, and passes undefined to activateAway', async () => {
    const t = setup({ front: [true] })
    await t.h.beforeMutation()
    expect(t.main.hide).toHaveBeenCalledTimes(1)
    expect(t.activateAway).toHaveBeenCalledWith(undefined)
  })

  it('a failing front check or activateAway does not throw', async () => {
    const t = setup()
    t.isOwnAppFront.mockRejectedValueOnce(new Error('helper'))
    await expect(t.h.beforeMutation(T)).resolves.toBeUndefined()
    const u = setup({ front: [true] })
    u.activateAway.mockRejectedValueOnce(new Error('focus_failed'))
    await expect(u.h.beforeMutation(T)).resolves.toBeUndefined()
  })

  it('restore shows only the windows we hid, inactive, and forgets them', async () => {
    const t = setup()
    await t.h.beforeMutation(T)
    t.h.restore()
    expect(t.main.showInactive).toHaveBeenCalledTimes(1)
    expect(t.other.showInactive).toHaveBeenCalledTimes(1)
    expect(t.hiddenAlready.showInactive).not.toHaveBeenCalled()
    expect(t.pet.showInactive).not.toHaveBeenCalled()
    t.h.restore()
    expect(t.main.showInactive).toHaveBeenCalledTimes(1)
  })

  it('restore leaves a window the user reopened alone', async () => {
    const t = setup()
    await t.h.beforeMutation(T)
    t.main.userShow()
    t.h.onUserShow(1)
    t.h.restore()
    expect(t.main.showInactive).not.toHaveBeenCalled()
    expect(t.other.showInactive).toHaveBeenCalledTimes(1)
  })

  it('restore skips a hidden window that is gone from the list (closed)', async () => {
    const t = setup()
    await t.h.beforeMutation(T)
    t.wins.splice(t.wins.indexOf(t.other), 1)
    t.h.restore()
    expect(t.other.showInactive).not.toHaveBeenCalled()
    expect(t.main.showInactive).toHaveBeenCalledTimes(1)
  })

  it('user reopen stops auto-hide for the rest of the turn; turnStarted turns it back on', async () => {
    const t = setup({ front: [true] })
    t.h.turnStarted()
    await t.h.beforeMutation(T)
    t.main.userShow()
    t.h.onUserShow(1)
    t.activateAway.mockClear()
    await t.h.beforeMutation(T)
    expect(t.main.hide).toHaveBeenCalledTimes(1)
    expect(t.activateAway).not.toHaveBeenCalled()
    t.h.restore()
    t.h.turnStarted()
    await t.h.beforeMutation(T)
    expect(t.main.hide).toHaveBeenCalledTimes(2)
  })

  it('show events caused by restore itself are not a user show', async () => {
    const t = setup()
    const h = t.h
    t.main.showInactive.mockImplementation(() => { h.onUserShow(1) })
    await h.beforeMutation(T)
    h.restore()
    h.turnStarted()
    await h.beforeMutation(T)
    expect(t.other.hide).toHaveBeenCalledTimes(2)
  })

  it('a show / focus before we stepped aside this turn is not a reopen', async () => {
    const t = setup()
    t.h.turnStarted()
    t.h.onUserShow(1)
    await t.h.beforeMutation(T)
    expect(t.main.hide).toHaveBeenCalledTimes(1)
  })

  it('after a mid-turn restore the next mutation steps aside again', async () => {
    const t = setup()
    await t.h.beforeMutation(T)
    t.h.restore()
    await t.h.beforeMutation(T)
    expect(t.main.hide).toHaveBeenCalledTimes(2)
  })

  it('not live (the turn ended / was stopped): a late beforeMutation after restore hides nothing and activates nothing', async () => {
    let live = true
    const t = setup({ front: [true], live: () => live })
    await t.h.beforeMutation(T)
    t.h.restore()
    live = false
    await t.h.beforeMutation(T)
    expect(t.main.hide).toHaveBeenCalledTimes(1)
    expect(t.main.isVisible()).toBe(true)
    expect(t.activateAway).toHaveBeenCalledTimes(1)
  })

  it('a restore while the front check is pending: no activateAway afterwards, and the windows stay restored', async () => {
    let answer: (v: boolean) => void = () => {}
    const t = setup()
    t.isOwnAppFront.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r }))
    const p = t.h.beforeMutation(T)
    expect(t.main.hide).toHaveBeenCalledTimes(1)
    t.h.restore()
    answer(true)
    await p
    expect(t.activateAway).not.toHaveBeenCalled()
    expect(t.main.isVisible()).toBe(true)
    expect(t.other.isVisible()).toBe(true)
  })

  it('live turning false while the front check is pending: no activateAway', async () => {
    let live = true
    let answer: (v: boolean) => void = () => {}
    const t = setup({ live: () => live })
    t.isOwnAppFront.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r }))
    const p = t.h.beforeMutation(T)
    live = false
    answer(true)
    await p
    expect(t.activateAway).not.toHaveBeenCalled()
  })
})
