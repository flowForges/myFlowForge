import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readBinding } from '../chat/chatStore'
import { asExtProvider } from './binding'
import { appName } from './occupancy'
import { isOwnTurnLive } from './ownTurns'
import type { ExtProvider } from './types'
import type { HandoffResult, HandoffTarget } from '@shared/types'

// 「在 <App> 中继续」:我方松手 → 打开官方 App → 把外部会话 id 放进剪贴板。官方 App 本来就读同一份存储,
// 我们不写任何外部文件;也不做自动定位(没有公开接口),用户在 App 的历史 / `/resume` 里选。
// ★排队中的消息不动:用户回来再发时照样过发送前的占用检查(sessionLink/handoff preSend)。

export interface AppHandoffDeps {
  platform?: NodeJS.Platform
  /** 这台机器上装了这个 App(只读检查)。 */
  appInstalled?: (app: string) => boolean
  /** `open -a <App>`。失败要抛。 */
  openApp?: (app: string) => Promise<void>
  copy?: (text: string) => void
  /** 收掉这个外部会话上我方留驻的 claude 进程,等它退出(退出时照常 recordOwnEnd)。 */
  stopClaude?: (cwd: string, nativeId: string) => Promise<void>
  /** 等这个线程上我方的 codex app-server 真退出。 */
  codexReaped?: (threadId: string) => Promise<void>
}


const ORDER: ExtProvider[] = ['codex', 'claude', 'qoder']

type ExecFileLike = (cmd: string, args: string[], cb: (err: Error | null) => void) => unknown

/** 参数数组直接给 open,不经 shell。 */
export const openAppWith = (execFile: ExecFileLike) => (app: string): Promise<void> =>
  new Promise((resolve, reject) => { execFile('open', ['-a', app], (err) => (err ? reject(err) : resolve())) })

export const appInstalledIn = (dirs: string[], exists: (p: string) => boolean = existsSync) => (app: string): boolean =>
  dirs.some(d => exists(join(d, `${app}.app`)))

export function defaultHandoffDeps(): AppHandoffDeps {
  return {
    platform: process.platform,
    appInstalled: appInstalledIn(['/Applications', join(homedir(), 'Applications')]),
    openApp: openAppWith(nodeExecFile as unknown as ExecFileLike),
  }
}

function available(ws: string, sid: string, agent: string, deps: AppHandoffDeps): { p: ExtProvider; id: string; app: string } | undefined {
  if ((deps.platform ?? process.platform) !== 'darwin') return undefined
  const p = asExtProvider(agent)
  const b = p && readBinding(ws, sid, agent)
  if (!p || !b?.resumeId) return undefined
  const app = appName(p)
  if (!(deps.appInstalled ?? (() => false))(app)) return undefined
  return { p, id: b.resumeId, app }
}

/** 会话菜单里能显示的「在 <App> 中继续」:有绑定 + darwin + App 装了;我方这一轮在途时灰掉。 */
export function handoffTargets(ws: string, sid: string, deps: AppHandoffDeps = {}): HandoffTarget[] {
  const out: HandoffTarget[] = []
  for (const agent of ORDER) {
    const a = available(ws, sid, agent, deps)
    if (a) out.push({ agent, app: a.app, disabled: isOwnTurnLive(ws, sid, agent) })
  }
  return out
}

export async function handOff(ws: string, sid: string, agent: string, deps: AppHandoffDeps = {}): Promise<HandoffResult> {
  const a = available(ws, sid, agent, deps)
  if (!a) return { ok: false, code: 'unavailable' }
  if (isOwnTurnLive(ws, sid, agent)) return { ok: false, code: 'busy' }
  // 1. 松手。收不掉也照样交出去:官方 App 那边还有自己的「已有写者」保护,我方下次发送前也会查占用。
  try {
    if (a.p === 'claude') await deps.stopClaude?.(ws, a.id)
    else if (a.p === 'codex') await deps.codexReaped?.(a.id)
    // qoder:进程每轮都退出,没东西可放。
  } catch { /* 进程刚好没了 */ }
  // 2. 打开官方 App。
  try { await (deps.openApp ?? (() => Promise.reject(new Error('no opener'))))(a.app) } catch { return { ok: false, code: 'open_failed' } }
  // 3. 会话 id 进剪贴板。
  try { deps.copy?.(a.id) } catch { /* 复制不了不算交接失败 */ }
  return { ok: true, id: a.id, app: a.app }
}
