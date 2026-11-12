import { describe, it, expect, vi } from 'vitest'
import { createPermissionProbe, PANE_URL } from './permissions'
import { fakeDriver } from './fakeDriver'
import { unsupportedDriver, CuDriverError } from './driver'

const mk = (o: Partial<Parameters<typeof createPermissionProbe>[0]> = {}) => {
  const openExternal = vi.fn(async (_u: string) => {})
  const driver = fakeDriver()
  const probe = createPermissionProbe({ driver, helperPath: () => '/x/forge-cu', openExternal, ...o })
  return { probe, openExternal, driver }
}

describe('PermissionProbe', () => {
  it('PANE_URL points at the two privacy panes', () => {
    expect(PANE_URL.screen).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    expect(PANE_URL.ax).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  })

  it('openPane calls the injected openExternal with the pane url', async () => {
    const { probe, openExternal } = mk()
    await probe.openPane('screen')
    await probe.openPane('ax')
    expect(openExternal.mock.calls.map((c) => c[0])).toEqual([PANE_URL.screen, PANE_URL.ax])
  })

  it('status maps helperPath()===null to helper:missing without touching the driver', async () => {
    const driver = fakeDriver()
    const spy = vi.spyOn(driver, 'status')
    const { probe } = mk({ driver, helperPath: () => null })
    const s = await probe.status()
    expect(s).toMatchObject({ supported: true, helper: 'missing', screen: false, ax: false })
    expect(spy).not.toHaveBeenCalled()
  })

  it('status maps a healthy driver', async () => {
    const { probe, driver } = mk()
    driver.setStatus({ screen: false, ax: true, osVersion: '14.5', osOK: true })
    expect(await probe.status()).toEqual({ supported: true, osOK: true, helper: 'ok', screen: false, ax: true, osVersion: '14.5' })
  })

  it('status reports osOK false on old systems', async () => {
    const { probe, driver } = mk()
    driver.setStatus({ osOK: false, osVersion: '13.2' })
    expect(await probe.status()).toMatchObject({ osOK: false, osVersion: '13.2' })
  })

  it('unsupported driver maps to supported:false', async () => {
    const { probe } = mk({ driver: unsupportedDriver('platform') })
    expect(await probe.status()).toMatchObject({ supported: false, screen: false, ax: false })
  })

  it('a failing helper leaves the feature supported but ungranted', async () => {
    const driver = fakeDriver()
    driver.status = async () => { throw new CuDriverError('helper_failed') }
    const { probe } = mk({ driver })
    expect(await probe.status()).toMatchObject({ supported: true, helper: 'ok', screen: false, ax: false })
  })

  it('request forwards to the driver', async () => {
    const { probe, driver } = mk()
    await probe.request('ax')
    expect(driver.requested).toEqual(['ax'])
  })
})
