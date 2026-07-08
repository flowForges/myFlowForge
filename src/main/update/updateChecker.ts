import type { UpdateInfo } from '@shared/types'
import { isNewer } from './version'

export const UPDATE_AVAILABLE = 'update:available'
export const UPDATE_NONE = 'update:none'
export const UPDATE_CHECK_FAILED = 'update:check-failed'

export interface CheckerDeps {
  repo: string
  currentVersion: () => string
  fetchLatest: (repo: string) => Promise<UpdateInfo | null>
  emit: (channel: string, payload: unknown) => void
  setTimeout: (fn: () => void, ms: number) => void
  setInterval: (fn: () => void, ms: number) => void
}

export interface UpdateChecker {
  check(manual?: boolean): Promise<UpdateInfo | null>
  start(): void
  current(): UpdateInfo | null
}

export function createUpdateChecker(deps: CheckerDeps): UpdateChecker {
  let info: UpdateInfo | null = null

  async function check(manual = false): Promise<UpdateInfo | null> {
    let latest: UpdateInfo | null
    try {
      latest = await deps.fetchLatest(deps.repo)
    } catch (e) {
      // GitHub unreachable (network/firewall/rate-limit). This is NOT "up to date" — do NOT clear a
      // previously-known pending update, and only surface it on a manual check so the version indicator
      // can say "检查失败" instead of lying with "已是最新".
      if (manual) deps.emit(UPDATE_CHECK_FAILED, { message: e instanceof Error ? e.message : String(e) })
      return info
    }
    if (latest && isNewer(latest.version, deps.currentVersion())) {
      info = latest
      deps.emit(UPDATE_AVAILABLE, { info })
    } else {
      info = null
      if (manual) deps.emit(UPDATE_NONE, {})
    }
    return info
  }

  function start() {
    deps.setTimeout(() => { void check() }, 10_000)
    deps.setInterval(() => { void check() }, 600_000)
  }

  return { check, start, current: () => info }
}
