import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimePaths } from '../protocol/paths'
import {
  applyAutostart, launchdPlist, planAutostart, startVbs, systemdUnit, windowsRunValue, xdgDesktop, type LaunchSpec,
} from './autostart'

const spec: LaunchSpec = { execPath: '/Apps/my App/Electron', daemonJs: '/Apps/R&D/mffaiDaemon.js', dataDir: '/h/.myFlowForge/mff-ai' }
const home = '/h'

describe('content generators', () => {
  it('plist has label, escaped paths, RunAtLoad true, KeepAlive false', () => {
    const p = launchdPlist(spec)
    expect(p).toContain('<string>com.myflowforge.mffai</string>')
    expect(p).toContain('<string>/Apps/R&amp;D/mffaiDaemon.js</string>')
    expect(p).toContain('<key>ELECTRON_RUN_AS_NODE</key>\n    <string>1</string>')
    expect(p).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(p).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/)
  })
  it('systemd unit quotes paths with spaces', () => {
    const u = systemdUnit(spec)
    expect(u).toContain('Environment=ELECTRON_RUN_AS_NODE=1')
    expect(u).toContain('ExecStart="/Apps/my App/Electron" "/Apps/R&D/mffaiDaemon.js"')
    expect(u).toContain('WantedBy=default.target')
    expect(xdgDesktop(spec)).toContain('"/Apps/my App/Electron"')
  })
  it('vbs quotes paths with spaces, hidden window', () => {
    const w: LaunchSpec = { execPath: 'C:\\Program Files\\App\\app.exe', daemonJs: 'C:\\x y\\d.js', dataDir: 'C:\\d' }
    const v = startVbs(w)
    expect(v).toContain('env("ELECTRON_RUN_AS_NODE") = "1"')
    expect(v).toContain('sh.Run """C:\\Program Files\\App\\app.exe"" ""C:\\x y\\d.js""", 0, False')
    expect(windowsRunValue(w)).toBe('wscript.exe "C:\\d\\run\\start.vbs"')
  })
})

describe('planAutostart', () => {
  const plist = join(home, 'Library/LaunchAgents/com.myflowforge.mffai.plist')
  it('darwin', () => {
    const env = { platform: 'darwin' as const, home, uid: 501, hasSystemdUser: false }
    const i = planAutostart('install', spec, env)
    expect(i.writes).toEqual([{ path: plist, content: launchdPlist(spec) }])
    expect(i.commands).toEqual([
      { argv: ['launchctl', 'bootout', 'gui/501/com.myflowforge.mffai'], ignoreFailure: true },
      { argv: ['launchctl', 'bootstrap', 'gui/501', plist] },
    ])
    expect(i.removes).toEqual([])
    expect(planAutostart('install', spec, env)).toEqual(i)
    const u = planAutostart('uninstall', spec, env)
    expect(u.writes).toEqual([])
    expect(u.removes).toEqual([plist])
    expect(u.commands).toEqual([{ argv: ['launchctl', 'bootout', 'gui/501/com.myflowforge.mffai'], ignoreFailure: true }])
  })
  const unit = join(home, '.config/systemd/user/mffai.service')
  const desk = join(home, '.config/autostart/mffai.desktop')
  it('linux with systemd', () => {
    const env = { platform: 'linux' as const, home, uid: 1000, hasSystemdUser: true }
    const i = planAutostart('install', spec, env)
    expect(i.writes).toEqual([{ path: unit, content: systemdUnit(spec) }])
    expect(i.removes).toEqual([desk])
    expect(i.commands.map((c) => c.argv)).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'mffai.service'],
    ])
    const u = planAutostart('uninstall', spec, env)
    expect(u.commands.map((c) => c.argv)).toEqual([['systemctl', '--user', 'disable', 'mffai.service']])
    expect(u.removes).toEqual([unit, desk])
    expect(u.after.map((c) => c.argv)).toEqual([['systemctl', '--user', 'daemon-reload']])
  })
  it('linux without systemd', () => {
    const env = { platform: 'linux' as const, home, uid: 1000, hasSystemdUser: false }
    const i = planAutostart('install', spec, env)
    expect(i.writes).toEqual([{ path: desk, content: xdgDesktop(spec) }])
    expect(i.commands).toEqual([])
    expect(planAutostart('uninstall', spec, env).removes).toEqual([desk, unit])
  })
  it('darwin under launchd: no bootout/bootstrap', () => {
    const env = { platform: 'darwin' as const, home, uid: 501, hasSystemdUser: false, runningUnderLaunchd: true }
    expect(planAutostart('install', spec, env)).toEqual({ writes: [{ path: plist, content: launchdPlist(spec) }], removes: [], commands: [], after: [] })
    expect(planAutostart('uninstall', spec, env)).toEqual({ writes: [], removes: [plist], commands: [], after: [] })
  })
  it('win32', () => {
    const env = { platform: 'win32' as const, home, hasSystemdUser: false }
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    const vbs = runtimePaths(spec.dataDir).startVbs
    expect(planAutostart('install', spec, env)).toEqual({
      writes: [{ path: vbs, content: startVbs(spec) }],
      removes: [],
      commands: [{ argv: ['reg', 'add', key, '/v', 'myFlowForge-mffai', '/t', 'REG_SZ', '/d', windowsRunValue(spec), '/f'] }],
      after: [],
    })
    expect(planAutostart('uninstall', spec, env)).toEqual({
      writes: [],
      removes: [vbs],
      commands: [{ argv: ['reg', 'delete', key, '/v', 'myFlowForge-mffai', '/f'], ignoreFailure: true }],
      after: [],
    })
  })
})

describe('applyAutostart', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-as-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('writes (mkdir -p), runs commands in order, removes, collects errors', async () => {
    const f = join(dir, 'a/b/c.txt')
    const gone = join(dir, 'gone')
    const calls: string[] = []
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args].join(' '))
      if (file === 'bad') throw new Error('nope')
    }
    const plan = {
      writes: [{ path: f, content: 'x' }], removes: [gone],
      commands: [{ argv: ['ok', '1'] }, { argv: ['bad'], ignoreFailure: true }, { argv: ['bad', '2'] }],
      after: [{ argv: ['ok', '3'] }],
    }
    const r = await applyAutostart(plan, exec)
    expect(readFileSync(f, 'utf8')).toBe('x')
    expect(existsSync(gone)).toBe(false)
    expect(calls).toEqual(['ok 1', 'bad', 'bad 2', 'ok 3'])
    expect(r).toEqual({ ok: false, errors: ['bad 2: nope'] })
  })
  it('a failed write skips commands', async () => {
    const blocker = join(dir, 'file')
    writeFileSync(blocker, '')
    const calls: string[] = []
    const r = await applyAutostart(
      { writes: [{ path: join(blocker, 'x/y'), content: 'x' }], removes: [], commands: [{ argv: ['launchctl', 'bootstrap'] }], after: [{ argv: ['z'] }] },
      async (f) => { calls.push(f) },
    )
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })
})
