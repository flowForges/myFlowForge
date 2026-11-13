// The computer-use:* IPC handlers (spec §5.2, §5.7, V1).
//
// All eleven channels are CLIENT_ONLY, so a remote client can't reach them through daemonTable(). This module is
// the second line of defence: any caller whose client isn't the local window gets `not_local` and nothing is touched.
// The check comes before argument validation and before the host is consulted.
import { COMPUTER_USE_MODES, type ComputerUseMode, type CuStatus } from '@shared/computerUse'
import type { InvokeEventLike } from '../ipc/invokeCtx'
import { CH } from '../ipc/channels'
import type { ComputerUseHost } from '../host/capabilities'
import type { CuSessionKey } from './types'

export const NOT_LOCAL = Object.freeze({ ok: false as const, code: 'not_local' as const })
const UNSUPPORTED = Object.freeze({ ok: false as const, code: 'unsupported' as const })
const INVALID = Object.freeze({ ok: false as const, code: 'invalid_args' as const })
const NO_STATUS: CuStatus = { supported: false, osOK: false, helper: 'missing', screen: false, ax: false }

type Handler = (e: InvokeEventLike, ...args: any[]) => unknown

/** fail closed: only the local window (`client.id === 'local'`) passes; a missing client is refused too */
const isLocal = (e: InvokeEventLike | undefined) => e?.client?.id === 'local'
const MODES = new Set<string>(COMPUTER_USE_MODES.map((m) => m.id))
const DECISIONS = new Set(['allow', 'deny', 'stop'])
const KINDS = new Set(['screen', 'ax'])

function keyOf(a: unknown): CuSessionKey | null {
  if (!a || typeof a !== 'object') return null
  const { workspacePath, sessionId } = a as Record<string, unknown>
  if (typeof workspacePath !== 'string' || !workspacePath || typeof sessionId !== 'string' || !sessionId) return null
  return { workspacePath, sessionId }
}
const kindOf = (a: unknown): 'screen' | 'ax' | null => {
  const k = a && typeof a === 'object' ? (a as { kind?: unknown }).kind : undefined
  return typeof k === 'string' && KINDS.has(k) ? (k as 'screen' | 'ax') : null
}

export interface ComputerUseIpcDeps {
  cu: () => ComputerUseHost | undefined
  /** sets settings.computerUse.requested[kind] = true through the normal settings save path */
  markRequested: (kind: 'screen' | 'ax') => void
}

export function computerUseHandlers(d: ComputerUseIpcDeps): Record<string, Handler> {
  /** local-only wrapper: the client check runs before anything else */
  const local = (fn: (cu: ComputerUseHost | undefined, a: any) => unknown): Handler =>
    async (e, a) => (isLocal(e) ? fn(d.cu(), a) : NOT_LOCAL)

  return {
    [CH.cuStatus]: local(async (cu) => {
      if (!cu) return NO_STATUS
      try { return await cu.probe.status() } catch { return { ...NO_STATUS, supported: true, helper: 'failed' as const } }
    }),

    [CH.cuState]: local(async (cu) => {
      if (!cu) return { sessions: [], gates: [] }
      return { sessions: cu.service.sessions(), gates: cu.service.pendingGates() }
    }),

    [CH.cuSetMode]: local(async (cu, a) => {
      const key = keyOf(a)
      const mode = a && typeof a === 'object' ? (a as { mode?: unknown }).mode : undefined
      if (!key || typeof mode !== 'string' || !MODES.has(mode)) return INVALID
      if (!cu) return UNSUPPORTED
      return cu.service.setMode(key, mode as ComputerUseMode, { local: true })
    }),

    [CH.cuResolve]: local(async (cu, a) => {
      const id = a && typeof a === 'object' ? (a as { id?: unknown }).id : undefined
      const decision = a && typeof a === 'object' ? (a as { decision?: unknown }).decision : undefined
      if (typeof id !== 'string' || !id || typeof decision !== 'string' || !DECISIONS.has(decision)) return INVALID
      if (!cu) return UNSUPPORTED
      const ok = await cu.service.resolve(id, decision as 'allow' | 'deny' | 'stop', { local: true })
      return ok ? { ok: true } : { ok: false, code: 'not_pending' }
    }),

    [CH.cuStop]: local(async (cu, a) => {
      if (!cu) return UNSUPPORTED
      // no key = stop everything (the overlay's 停止 and the global hotkey)
      cu.service.stop(keyOf(a) ?? undefined, 'user')
      return { ok: true }
    }),

    [CH.cuLog]: local(async (cu, a) => {
      const key = keyOf(a)
      if (!key) return INVALID
      if (!cu) return []
      return cu.log.list(key)
    }),

    [CH.cuThumb]: local(async (cu, a) => {
      const key = keyOf(a)
      const file = a && typeof a === 'object' ? (a as { file?: unknown }).file : undefined
      if (!key || typeof file !== 'string' || !file) return INVALID
      if (!cu) return null
      return cu.log.thumb(key, file)
    }),

    [CH.cuRequestPermission]: local(async (cu, a) => {
      const kind = kindOf(a)
      if (!kind) return INVALID
      if (!cu) return UNSUPPORTED
      await cu.probe.request(kind)
      await cu.probe.openPane(kind)
      d.markRequested(kind)
      return { ok: true }
    }),

    [CH.cuOpenSettings]: local(async (cu, a) => {
      const kind = kindOf(a)
      if (!kind) return INVALID
      if (!cu) return UNSUPPORTED
      await cu.probe.openPane(kind)
      return { ok: true }
    }),

    [CH.cuRunningApps]: local(async (cu) => {
      if (!cu?.runningApps) return []
      try { return await cu.runningApps() } catch { return [] }
    }),

    [CH.cuCollapseMain]: local(async (cu) => {
      if (!cu) return UNSUPPORTED
      cu.collapseMain?.()
      return { ok: true }
    }),
  }
}
