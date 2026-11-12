import type { CuStatus } from '@shared/computerUse'
import { CuDriverError, type ComputerDriver } from './driver'

export interface PermissionProbe {
  status(): Promise<CuStatus>
  request(kind: 'screen' | 'ax'): Promise<void>
  openPane(kind: 'screen' | 'ax'): Promise<void>
}

export const PANE_URL = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  ax: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
} as const

export function createPermissionProbe(o: {
  driver: ComputerDriver
  helperPath: () => string | null
  openExternal: (url: string) => Promise<void> | void
}): PermissionProbe {
  return {
    async status(): Promise<CuStatus> {
      if (o.helperPath() === null) return { supported: true, osOK: true, helper: 'missing', screen: false, ax: false }
      try {
        const s = await o.driver.status()
        return { supported: true, osOK: s.osOK, helper: 'ok', screen: s.screen, ax: s.ax, osVersion: s.osVersion }
      } catch (e) {
        // `unsupported` is the feature being unavailable; any other failure is a helper hiccup, not a missing feature.
        if (e instanceof CuDriverError && e.code === 'unsupported') {
          return { supported: false, osOK: false, helper: 'ok', screen: false, ax: false }
        }
        return { supported: true, osOK: true, helper: 'ok', screen: false, ax: false }
      }
    },
    request: (kind) => o.driver.request(kind),
    async openPane(kind) { await o.openExternal(PANE_URL[kind]) },
  }
}
