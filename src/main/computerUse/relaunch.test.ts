import { describe, it, expect } from 'vitest'
import { relaunchOptions, relaunchPlan } from './relaunch'

// app.relaunch() starts the new instance as a child of Electron's relauncher, so its responsible process is the old
// instance. Once that dies the SPI answers every pid for itself and forge-cu refuses (self_responsible) for the whole
// life of the new instance (实测 1.3.0-cu.1, 09:09–12:35). Relaunching through LaunchServices makes it its own.
describe('relaunchOptions', () => {
  const exe = '/Applications/myFlowForge Test.app/Contents/MacOS/myFlowForge Test'
  it('packaged darwin: open -n the bundle, so launchd starts it and it is its own responsible process', () => {
    expect(relaunchOptions('darwin', true, exe)).toEqual({ execPath: '/usr/bin/open', args: ['-n', '/Applications/myFlowForge Test.app'] })
  })
  it('a translocated / DMG bundle relaunches from where it runs', () => {
    const t = '/private/var/folders/xy/T/AppTranslocation/ABC/d/myFlowForge Test.app/Contents/MacOS/myFlowForge Test'
    expect(relaunchOptions('darwin', true, t)?.args).toEqual(['-n', '/private/var/folders/xy/T/AppTranslocation/ABC/d/myFlowForge Test.app'])
  })
  it('dev, other platforms or an execPath outside a bundle: Electron default', () => {
    expect(relaunchOptions('darwin', false, exe)).toBeUndefined()
    expect(relaunchOptions('linux', true, '/opt/myFlowForge/myflowforge')).toBeUndefined()
    expect(relaunchOptions('win32', true, 'C:\\\\x\\\\myFlowForge.exe')).toBeUndefined()
    expect(relaunchOptions('darwin', true, '/usr/local/bin/electron')).toBeUndefined()
  })
})

// Review ruling (1.2.11): only computer use's 需重启 takes the LaunchServices path and the before-quit cleanup;
// every other caller of app:relaunch (Appearance 立即重启生效 …) keeps plain app.relaunch().
describe('relaunchPlan', () => {
  const exe = '/Applications/myFlowForge.app/Contents/MacOS/myFlowForge'
  it.each([undefined, null, {}, { computerUse: false }, { computerUse: 'yes' }, 'computerUse'])('%j: unchanged app.relaunch(), no cleanup', (a) => {
    expect(relaunchPlan(a, 'darwin', true, exe)).toEqual({ options: undefined, cleanup: false })
  })
  it('{computerUse:true}: open -n and the before-quit cleanup', () => {
    expect(relaunchPlan({ computerUse: true }, 'darwin', true, exe)).toEqual({ options: { execPath: '/usr/bin/open', args: ['-n', '/Applications/myFlowForge.app'] }, cleanup: true })
    expect(relaunchPlan({ computerUse: true }, 'darwin', false, exe)).toEqual({ options: undefined, cleanup: true })
  })
})
