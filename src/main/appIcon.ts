import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DockIcon } from './config/schema'

export const APP_ICON_RESOURCE_DIR = 'app-icons'
export const MENU_BAR_ICON_FILENAME = 'flowforge-menubar-template.png'

export const APP_ICON_OPTIONS: { id: DockIcon; label: string; filename: string }[] = [
  { id: 'ice-cyan', label: 'Ice Cyan', filename: 'flowforge-ice-cyan.png' },
  { id: 'forge-aurora', label: 'Forge Aurora', filename: 'flowforge-forge-aurora.png' },
  { id: 'cobalt-violet', label: 'Cobalt Violet', filename: 'flowforge-cobalt-violet.png' },
  { id: 'ember-violet', label: 'Ember Violet', filename: 'flowforge-ember-violet.png' },
  { id: 'magenta-pulse', label: 'Magenta Pulse', filename: 'flowforge-magenta-pulse.png' },
]

interface AppIconPathEnv {
  resourcesPath: string
  appPath: string
  isPackaged: boolean
}

const defaultDockIcon: DockIcon = 'ember-violet'

function assetBase(env: AppIconPathEnv) {
  return env.isPackaged
    ? join(env.resourcesPath, APP_ICON_RESOURCE_DIR)
    : join(env.appPath, 'build', APP_ICON_RESOURCE_DIR)
}

export function resolveDockIconPath(env: AppIconPathEnv, id: DockIcon): string {
  const opt = APP_ICON_OPTIONS.find(o => o.id === id) ?? APP_ICON_OPTIONS.find(o => o.id === defaultDockIcon)!
  return join(assetBase(env), opt.filename)
}

export function resolveMenuBarIconPath(env: AppIconPathEnv): string {
  return join(assetBase(env), MENU_BAR_ICON_FILENAME)
}

export function resolveAppIconOptions(env: AppIconPathEnv): Array<{ id: DockIcon; label: string; filename: string; src: string }> {
  const base = assetBase(env)
  return APP_ICON_OPTIONS.map(opt => ({
    ...opt,
    src: pathToFileURL(join(base, opt.filename)).toString(),
  }))
}
