import { describe, it, expect, vi } from 'vitest'
import { createUpdateChecker } from './updateChecker'
import type { CheckerDeps } from './updateChecker'
import type { UpdateInfo } from '@shared/types'

const INFO: UpdateInfo = { version: '2.4.0', notes: 'n', dmgUrl: 'u', dmgSize: 10, dmgName: 'a.dmg' }

function deps(o: Partial<CheckerDeps> = {}): CheckerDeps {
  return {
    repo: 'o/r',
    currentVersion: () => '1.0.0',
    fetchLatest: async () => INFO,
    emit: vi.fn(),
    setTimeout: vi.fn(),
    setInterval: vi.fn(),
    ...o,
  }
}

describe('createUpdateChecker', () => {
  it('emits update:available and stores info when newer', async () => {
    const d = deps()
    const c = createUpdateChecker(d)
    const got = await c.check()
    expect(got).toEqual(INFO)
    expect(c.current()).toEqual(INFO)
    expect(d.emit).toHaveBeenCalledWith('update:available', { info: INFO })
  })
  it('stores null and stays quiet on an auto check when up to date', async () => {
    const d = deps({ currentVersion: () => '2.4.0' })
    const c = createUpdateChecker(d)
    expect(await c.check()).toBeNull()
    expect(c.current()).toBeNull()
    expect(d.emit).not.toHaveBeenCalled()
  })
  it('emits update:none on a MANUAL check when up to date', async () => {
    const d = deps({ currentVersion: () => '2.4.0' })
    const c = createUpdateChecker(d)
    await c.check(true)
    expect(d.emit).toHaveBeenCalledWith('update:none', {})
  })
  it('treats a null source result as no update', async () => {
    const d = deps({ fetchLatest: async () => null })
    const c = createUpdateChecker(d)
    expect(await c.check()).toBeNull()
    expect(d.emit).not.toHaveBeenCalled()
  })
  it('start() schedules the 10s first check and the 10min interval', () => {
    const d = deps()
    createUpdateChecker(d).start()
    expect(d.setTimeout).toHaveBeenCalledWith(expect.any(Function), 10_000)
    expect(d.setInterval).toHaveBeenCalledWith(expect.any(Function), 600_000)
  })
})
