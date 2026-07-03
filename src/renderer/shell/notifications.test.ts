import { describe, it, expect } from 'vitest'
import { ICN, unreadCount, badgeText, markAllRead, hasPopoverContent, type Notif } from './notifications'
import { MOCK_NOTIFS } from './notifications.fixtures'

describe('notifications mock data', () => {
  it('MOCK_NOTIFS has 4 items, 2 unread', () => {
    expect(MOCK_NOTIFS).toHaveLength(4)
    expect(MOCK_NOTIFS.filter(n => n.unread)).toHaveLength(2)
  })

  it('ICN has ok/warn/file/up svg strings', () => {
    expect(ICN.ok).toContain('<svg')
    expect(ICN.warn).toContain('<svg')
    expect(ICN.file).toContain('<svg')
    expect(ICN.up).toContain('<svg')
  })
})

describe('unreadCount', () => {
  it('counts unread notifs', () => {
    expect(unreadCount(MOCK_NOTIFS)).toBe(2)
    expect(unreadCount([])).toBe(0)
  })
})

describe('badgeText', () => {
  it('adds 1 for an available update', () => {
    expect(badgeText(2, true)).toBe('3')
  })
  it('is 0 when nothing unread and no update', () => {
    expect(badgeText(0, false)).toBe('0')
  })
  it('caps at 9+', () => {
    expect(badgeText(20, false)).toBe('9+')
  })
})

describe('hasPopoverContent / badge invariant', () => {
  const read: Notif = { ic: 'ok', cls: 'ni-ok', t: 'x', m: 'y', unread: false }
  const unread: Notif = { ...read, unread: true }

  it('is true when an update is available (even with empty notifs)', () => {
    expect(hasPopoverContent([], true)).toBe(true)
  })
  it('is true when there are notifs but no update', () => {
    expect(hasPopoverContent([read], false)).toBe(true)
  })
  it('is false only when there is nothing to show', () => {
    expect(hasPopoverContent([], false)).toBe(false)
  })

  // The core guarantee: any state that lights the badge must have popover content.
  it('badge !== "0" always implies popover content', () => {
    const notifSets: Notif[][] = [[], [read], [unread], [read, unread], MOCK_NOTIFS]
    for (const ns of notifSets) {
      for (const updateAvailable of [true, false]) {
        const badge = badgeText(unreadCount(ns), updateAvailable)
        if (badge !== '0') {
          expect(hasPopoverContent(ns, updateAvailable)).toBe(true)
        }
      }
    }
  })
})

describe('markAllRead', () => {
  it('returns a new array with all read, original untouched', () => {
    const out = markAllRead(MOCK_NOTIFS)
    expect(out.every(n => !n.unread)).toBe(true)
    expect(out).not.toBe(MOCK_NOTIFS)
    expect(MOCK_NOTIFS.filter(n => n.unread)).toHaveLength(2)
  })
})
