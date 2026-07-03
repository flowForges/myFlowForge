import type { UpdateInfo } from '@shared/types'
import { isNewer } from './version'

export const UPDATE_AVAILABLE = 'update:available'
export const UPDATE_NONE = 'update:none'

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
    const latest = await deps.fetchLatest(deps.repo)
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
