import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runtimePaths } from '../protocol/paths'

// 开机自启(spec §7):内容与命令是纯函数,applyAutostart 只做薄执行

export type LaunchSpec = { execPath: string; daemonJs: string; dataDir: string }
export type AutostartEnv = { platform: NodeJS.Platform; home: string; uid?: number; hasSystemdUser: boolean; runningUnderLaunchd?: boolean }
export type Cmd = { argv: string[]; ignoreFailure?: boolean }
export type AutostartPlan = {
  writes: { path: string; content: string }[]
  removes: string[]
  // 顺序:writes → commands → removes → after
  commands: Cmd[]
  after: Cmd[]
}
export type ExecFn = (file: string, args: string[]) => Promise<void>

export const LAUNCHD_LABEL = 'com.myflowforge.mffai'
export const SYSTEMD_UNIT = 'mffai.service'
export const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const WIN_RUN_NAME = 'myFlowForge-mffai'

const xmlEsc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export function launchdPlist(spec: LaunchSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEsc(spec.execPath)}</string>
    <string>${xmlEsc(spec.daemonJs)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
    <key>MFFAI_DATA_DIR</key>
    <string>${xmlEsc(spec.dataDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`
}

// systemd 参数:双引号包裹,转义 \ " 与 %(说明符)
const sdQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`

export function systemdUnit(spec: LaunchSpec): string {
  return `[Unit]
Description=myFlowForge mff-ai daemon

[Service]
Type=simple
Environment=ELECTRON_RUN_AS_NODE=1
Environment=${sdQuote(`MFFAI_DATA_DIR=${spec.dataDir}`)}
ExecStart=${sdQuote(spec.execPath)} ${sdQuote(spec.daemonJs)}

[Install]
WantedBy=default.target
`
}

// desktop entry 的 Exec 引号规则:\ " ` $ 前加反斜杠,% 写成 %%
const deQuote = (s: string) => `"${s.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%')}"`

export function xdgDesktop(spec: LaunchSpec): string {
  const env = deQuote(`MFFAI_DATA_DIR=${spec.dataDir}`)
  return `[Desktop Entry]
Type=Application
Name=myFlowForge mff-ai
Exec=env ELECTRON_RUN_AS_NODE=1 ${env} ${deQuote(spec.execPath)} ${deQuote(spec.daemonJs)}
Terminal=false
X-GNOME-Autostart-enabled=true
`
}

const vbsQuote = (s: string) => `"${s.replace(/"/g, '""')}"`

export function startVbs(spec: LaunchSpec): string {
  const cmd = `""${spec.execPath.replace(/"/g, '""""')}"" ""${spec.daemonJs.replace(/"/g, '""""')}""`
  return `Set sh = CreateObject("WScript.Shell")
Set env = sh.Environment("Process")
env("ELECTRON_RUN_AS_NODE") = "1"
env("MFFAI_DATA_DIR") = ${vbsQuote(spec.dataDir)}
sh.Run "${cmd}", 0, False
`
}

export function windowsRunValue(spec: LaunchSpec): string {
  return `wscript.exe "${spec.dataDir}\\run\\start.vbs"`
}

const plistPath = (home: string) => join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
const unitPath = (home: string) => join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
const desktopPath = (home: string) => join(home, '.config', 'autostart', 'mffai.desktop')

export function planAutostart(op: 'install' | 'uninstall', spec: LaunchSpec, env: AutostartEnv): AutostartPlan {
  const plan: AutostartPlan = { writes: [], removes: [], commands: [], after: [] }
  const install = op === 'install'
  if (env.platform === 'darwin') {
    if (env.uid === undefined) throw new Error('cannot resolve uid for launchctl')
    const domain = `gui/${env.uid}`
    const p = plistPath(env.home)
    // 本进程由该 launchd 作业拉起时,bootout 会杀掉自己:只改 plist(已加载;卸载下次登录生效)
    const self = env.runningUnderLaunchd === true
    if (!self) plan.commands.push({ argv: ['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`], ignoreFailure: true })
    if (install) {
      plan.writes.push({ path: p, content: launchdPlist(spec) })
      if (!self) plan.commands.push({ argv: ['launchctl', 'bootstrap', domain, p] })
    } else {
      plan.removes.push(p)
    }
  } else if (env.platform === 'win32') {
    const vbs = runtimePaths(spec.dataDir).startVbs
    if (install) {
      plan.writes.push({ path: vbs, content: startVbs(spec) })
      plan.commands.push({ argv: ['reg', 'add', WIN_RUN_KEY, '/v', WIN_RUN_NAME, '/t', 'REG_SZ', '/d', windowsRunValue(spec), '/f'] })
    } else {
      plan.commands.push({ argv: ['reg', 'delete', WIN_RUN_KEY, '/v', WIN_RUN_NAME, '/f'], ignoreFailure: true })
      plan.removes.push(vbs)
    }
  } else if (env.hasSystemdUser) {
    // 守护进程此时已在运行,只 enable,不 --now
    if (install) {
      plan.writes.push({ path: unitPath(env.home), content: systemdUnit(spec) })
      plan.removes.push(desktopPath(env.home))
      plan.commands.push({ argv: ['systemctl', '--user', 'daemon-reload'] }, { argv: ['systemctl', '--user', 'enable', SYSTEMD_UNIT] })
    } else {
      plan.commands.push({ argv: ['systemctl', '--user', 'disable', SYSTEMD_UNIT], ignoreFailure: true })
      plan.removes.push(unitPath(env.home), desktopPath(env.home))
      plan.after.push({ argv: ['systemctl', '--user', 'daemon-reload'] })
    }
  } else if (install) {
    plan.writes.push({ path: desktopPath(env.home), content: xdgDesktop(spec) })
    plan.removes.push(unitPath(env.home))
  } else {
    plan.removes.push(desktopPath(env.home), unitPath(env.home))
  }
  return plan
}

export const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  })

/** 探测 systemd 用户会话 */
export async function probeSystemdUser(exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    await exec('systemctl', ['--user', 'show-environment'])
    return true
  } catch {
    return false
  }
}

/** 执行计划;失败收集为字符串,不抛 */
export async function applyAutostart(plan: AutostartPlan, exec: ExecFn = defaultExec): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = []
  const run = async (c: Cmd) => {
    try {
      await exec(c.argv[0], c.argv.slice(1))
    } catch (err) {
      if (!c.ignoreFailure) errors.push(`${c.argv.join(' ')}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  for (const w of plan.writes) {
    try {
      mkdirSync(dirname(w.path), { recursive: true })
      writeFileSync(w.path, w.content)
    } catch (err) {
      errors.push(`write ${w.path}: ${String(err)}`)
    }
  }
  // 写失败则不执行命令,免得 bootstrap 过期/缺失的文件
  const writeFailed = errors.length > 0
  if (!writeFailed) for (const c of plan.commands) await run(c)
  for (const p of plan.removes) {
    try {
      rmSync(p, { force: true })
    } catch (err) {
      errors.push(`remove ${p}: ${String(err)}`)
    }
  }
  if (!writeFailed) for (const c of plan.after) await run(c)
  return { ok: errors.length === 0, errors }
}
