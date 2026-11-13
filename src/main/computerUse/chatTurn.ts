// How a chat turn gets (or doesn't get) the computer tools. Spec §4.3, §5.2, §5.3, V12, F30.
//
// runTurn calls `cuPreflight` right after the browser check and, if it gives a conflict, rejects the whole turn the
// same way. Just before sendTurn it calls `cuBeginTurn`, and the function that returns goes in `finally`.
//
// The tools reach a turn only when all of these hold. The server stamped `origin === 'local'` (missing = non-local).
// The provider is in COMPUTER_USE_PROVIDERS (Tier-2 providers would write the token into project files). The mode was
// on at preflight, so the conflict check ran and passed, and it's still on at beginTurn.
import { COMPUTER_TOOLS, computerUseConflict, providerSupportsComputerUse, type CuStatus } from '@shared/computerUse'
import type { ChatSendPayload } from '@shared/types'
import type { PermissionMode } from '@shared/permissions'
import type { ComputerUseHost } from '../host/capabilities'
import type { CuSessionKey } from './types'

type Origin = ChatSendPayload['origin']

const HELPER_FAILED: CuStatus = { supported: true, osOK: true, helper: 'failed', screen: false, ax: false }
const BRIDGE_FAILED = '电脑操作组件无法启动 · 请重新安装或重启应用'

const ORIGIN_LABEL: Record<Exclude<NonNullable<Origin>, 'local'>, string> = {
  remote: '远程设备', bot: '机器人', pet: '宠物', workflow: '工作流',
}

export function originNote(origin: Origin): string {
  const from = origin && origin !== 'local' ? ORIGIN_LABEL[origin] : '未标明的入口'
  return `这一轮来自 ${from} · 电脑操作只对本机输入框发出的消息生效`
}

export interface CuArmed { socketPath: string; configDir: string }

/**
 * Before anything is spawned: does this turn conflict with the mode, and if it will get the tools, where's the socket.
 * Only a local turn on a supported provider with the mode on is checked. Other turns run as usual without the tools,
 * so a conflict doesn't concern them.
 */
export async function cuPreflight(
  cu: ComputerUseHost | undefined,
  key: CuSessionKey,
  a: { origin: Origin; agent: string; perm: PermissionMode },
): Promise<{ conflict: string | null; armed: CuArmed | null }> {
  if (!cu || a.origin !== 'local' || !providerSupportsComputerUse(a.agent)) return { conflict: null, armed: null }
  const mode = cu.service.modeOf(key)
  if (mode === 'off') return { conflict: null, armed: null }
  let status: CuStatus
  try { status = await cu.probe.status() } catch { status = HELPER_FAILED }
  const conflict = computerUseConflict({ mode, perm: a.perm, provider: a.agent, status })
  if (conflict) return { conflict, armed: null }
  try {
    const b = await cu.bridge()
    return { conflict: null, armed: { socketPath: b.socketPath, configDir: b.configDir } }
  } catch {
    return { conflict: BRIDGE_FAILED, armed: null }
  }
}

/**
 * Registers the turn with the service and, for an armed local turn, adds the five FORGE_* keys to `env`. When the mode
 * is on but the turn isn't local, leaves the origin note. Returns the `endTurn` call for `finally`.
 */
export function cuBeginTurn(
  cu: ComputerUseHost | undefined,
  key: CuSessionKey,
  a: { origin: Origin; agent: string; armed: CuArmed | null; env: NodeJS.ProcessEnv; mcpEntry: string; note: (text: string) => void },
): () => void {
  if (!cu) return () => {}
  const { tools } = cu.service.beginTurn(key, a.origin)
  if (a.origin !== 'local' && cu.service.modeOf(key) !== 'off') a.note(originNote(a.origin))
  const token = cu.service.tokenFor(key)
  if (tools && a.armed && token && a.origin === 'local' && providerSupportsComputerUse(a.agent)) {
    a.env.FORGE_SOCKET = a.armed.socketPath
    a.env.FORGE_MCP_DIR = a.armed.configDir
    a.env.FORGE_AGENT_ID = token
    a.env.FORGE_MCP_ENTRY = a.mcpEntry
    a.env.FORGE_TOOLS = COMPUTER_TOOLS.join(',')
  }
  let ended = false
  return () => {
    if (ended) return
    ended = true
    cu.service.endTurn(key)
  }
}
