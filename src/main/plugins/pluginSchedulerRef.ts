import type { PluginScheduler } from './pluginScheduler'

let current: PluginScheduler | null = null

export const setPluginScheduler = (s: PluginScheduler | null): void => { current = s }
export const getPluginScheduler = (): PluginScheduler | null => current
