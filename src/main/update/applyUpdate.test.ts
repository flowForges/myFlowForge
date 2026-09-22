import { describe, it, expect } from 'vitest'
import { planApply, macBundleOf, macApplyScript, WIN_SILENT_ARGS, type PlanEnv } from './applyUpdate'

const MAC: PlanEnv = {
  platform: 'darwin', isPackaged: true, assetName: 'myFlowForge-1.2.3-arm64.dmg',
  execPath: '/Applications/myFlowForge.app/Contents/MacOS/myFlowForge', canWrite: () => true,
}

describe('planApply', () => {
  it('mac: replaces the bundle the app is running from', () => {
    expect(planApply(MAC)).toEqual({ kind: 'mac', target: '/Applications/myFlowForge.app' })
  })
  it('mac: falls back to the manual installer when replacing cannot work', () => {
    expect(planApply({ ...MAC, isPackaged: false }).kind).toBe('manual')
    expect(planApply({ ...MAC, execPath: '/Volumes/myFlowForge/myFlowForge.app/Contents/MacOS/myFlowForge' }).kind).toBe('manual')
    expect(planApply({ ...MAC, execPath: '/private/var/folders/x/AppTranslocation/ABC/d/myFlowForge.app/Contents/MacOS/myFlowForge' }).kind).toBe('manual')
    expect(planApply({ ...MAC, canWrite: p => p !== '/Applications' }).kind).toBe('manual')
    expect(planApply({ ...MAC, assetName: 'x.zip' }).kind).toBe('manual')
  })
  it('windows: silent NSIS for an exe, manual otherwise', () => {
    expect(planApply({ ...MAC, platform: 'win32', assetName: 'myFlowForge-1.2.3-x64-setup.exe' })).toEqual({ kind: 'win' })
    expect(planApply({ ...MAC, platform: 'linux' }).kind).toBe('manual')
  })
  it('windows args: /S silent + --updated (wait for the old process instead of the "please close" dialog) + --force-run (relaunch)', () => {
    expect([...WIN_SILENT_ARGS]).toEqual(['/S', '--updated', '--force-run'])
  })
})

describe('macBundleOf', () => {
  it('walks up Contents/MacOS to the .app', () => {
    expect(macBundleOf('/Users/a/Apps/my app.app/Contents/MacOS/myFlowForge')).toBe('/Users/a/Apps/my app.app')
    expect(macBundleOf('/usr/local/bin/electron')).toBeNull()
  })
})

describe('macApplyScript', () => {
  it('quotes every path so spaces and quotes cannot break out of the string', () => {
    const s = macApplyScript({ pid: 42, dmg: "/tmp/it's here.dmg", target: '/Users/a/My Apps/myFlowForge.app', logPath: '/tmp/l og' })
    expect(s).toContain(`DMG='/tmp/it'\\''s here.dmg'`)
    expect(s).toContain(`TARGET='/Users/a/My Apps/myFlowForge.app'`)
    expect(s).toContain(`STAGE='/Users/a/My Apps/.myFlowForge.app.new'`)
    expect(s).toContain('PID=42')
  })
  it('copies fully before touching the old app, and restores it on failure', () => {
    const s = macApplyScript({ pid: 1, dmg: '/d.dmg', target: '/A/x.app', logPath: '/l' })
    expect(s.indexOf('ditto "$SRC" "$STAGE"')).toBeLessThan(s.indexOf('mv "$TARGET" "$OLD"'))
    expect(s).toContain('mv "$STAGE" "$TARGET" || restore')
    expect(s).toMatch(/restore\(\) \{[\s\S]*mv "\$OLD" "\$TARGET"[\s\S]*open "\$TARGET"/)
  })
})
