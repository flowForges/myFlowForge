// 状态条和导航数字要的后台数据(08 §6.1、§6.2)。只在后台连上时取;相关事件和 reset 时重取,另有一个慢的兜底轮询
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EventType } from '@mffai/protocol'
import { call } from './rpc'
import { onMffaiEvent, onMffaiReset } from './events'
import { modelsOf } from './useModels'
import type { StripInfo } from './StatusStrip'
import type { MffaiPage } from './route'

export type NavCounts = Partial<Record<MffaiPage, number>>

const REFRESH_ON: readonly EventType[] = [
  'kernel.started', 'plugin.activated', 'plugin.failed', 'permissions.updated', 'account.updated',
  'approval.requested', 'approval.resolved', 'session.created', 'session.deleted', 'turn.ended', 'turn.failed',
  'memory.proposal', 'memory.updated',
  'plugins.installed', 'plugins.upgraded', 'plugins.enabled', 'plugins.disabled', 'plugins.uninstalled',
  'plugins.integrity.failed', 'plugins.dev.loaded', 'plugins.dev.trusted',
]
const DEBOUNCE_MS = 250
const POLL_MS = 15_000

const settle = <T,>(p: Promise<T>): Promise<T | undefined> => p.then((v) => v, () => undefined)

export function useShellInfo(connected: boolean): { info: StripInfo; counts: NavCounts } {
  const [info, setInfo] = useState<StripInfo>({})
  const [counts, setCounts] = useState<NavCounts>({})
  const gen = useRef(0)

  const load = useCallback(async () => {
    const g = ++gen.current
    const [status, list, health, catalog, accounts] = await Promise.all([
      settle(call('status')), settle(call('session.list')), settle(call('memory.health')),
      settle(call('models.catalog')), settle(call('models.accounts')),
    ])
    const def = catalog?.default
    const account = def && accounts?.accounts.find((a) => a.id === def.accountId)
    const quota = account ? await settle(call('models.quota', { accountId: account.id })) : undefined
    if (g !== gen.current) return
    const pending = list?.sessions.reduce((n, s) => n + s.pendingApprovals, 0)
    const broken = status?.plugins.filter((p) => p.state !== 'active').length
    setInfo({
      ...(status && { status }),
      ...(pending !== undefined && { pending }),
      ...(def && account && {
        model: { account: account.label, model: modelsOf(catalog ?? null, account).find((m) => m.id === def.modelId)?.name ?? def.modelId, quota: quota ?? null },
      }),
    })
    setCounts({
      ...(pending && { chat: pending }),
      ...(health?.pendingProposals && { memory: health.pendingProposals }),
      ...(broken && { plugins: broken }),
    })
  }, [])

  useEffect(() => {
    if (!connected) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => void load(), DEBOUNCE_MS) }
    void load()
    const offE = onMffaiEvent({ types: REFRESH_ON }, soon)
    const offR = onMffaiReset(() => void load())
    const poll = setInterval(() => void load(), POLL_MS)
    return () => { clearTimeout(timer); clearInterval(poll); offE(); offR(); gen.current++ }
  }, [connected, load])

  return { info, counts }
}
