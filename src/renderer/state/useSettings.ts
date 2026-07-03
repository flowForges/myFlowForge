import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings, Appearance, Pet, Terminal, CloseAction, AppIcon } from '@shared/types'
import { DEFAULT_BUILTIN_PET_ID, builtinPets } from '@shared/builtinPets'

const DEFAULTS: Settings = {
  appearance: { theme: 'light', accent: 'blue', vibrancy: false, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 'medium' },
  closeAction: 'ask',
  appIcon: { dockIcon: 'ember-violet', showMenuBar: false },
  termProxy: '',
  skills: { 'code-review': true, 'test-driven': true, 'deep-research': false, 'systematic-debugging': true },
  pet: { enabled: true, skin: 'custom', customPets: builtinPets(), activeCustomPetId: `builtin-${DEFAULT_BUILTIN_PET_ID}`, corner: 'right', pos: { bottom: 24 }, followCursor: false, scale: 1, notify: { confirm: true, input: true, done: false }, interactionMode: 'simple', states: { idle: { anim: 'float', accent: 'none' }, working: { anim: 'spin-halo', accent: 'none' }, confirm: { anim: 'alert', accent: 'warn' }, input: { anim: 'tilt', accent: 'accent' }, done: { anim: 'pulse-ok', accent: 'ok' } } },
  heartbeat: { stallMs: 90_000, killGraceMs: 60_000, pingMs: 15_000 },
  pinnedWorkspaces: [],
  workspaceOrder: [],
  lastActiveWorkspace: '',
  pluginCreds: {},
  terminal: { fontFamily: "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace", fontSize: 12.5 },
}

export interface SettingsUpdate {
  appearance?: Partial<Appearance>
  closeAction?: CloseAction
  appIcon?: Partial<AppIcon>
  termProxy?: string
  skills?: Record<string, boolean>
  pet?: Partial<Pet>
  heartbeat?: Settings['heartbeat']
  terminal?: Partial<Terminal>
  lastActiveWorkspace?: string
}

function merge(base: Settings, partial: SettingsUpdate): Settings {
  return {
    appearance: { ...base.appearance, ...(partial.appearance ?? {}) },
    closeAction: partial.closeAction ?? base.closeAction,
    appIcon: { ...base.appIcon, ...(partial.appIcon ?? {}) },
    termProxy: partial.termProxy ?? base.termProxy,
    skills: { ...base.skills, ...(partial.skills ?? {}) },
    pet: { ...base.pet, ...(partial.pet ?? {}) },
    heartbeat: partial.heartbeat ?? base.heartbeat,
    pinnedWorkspaces: base.pinnedWorkspaces,
    // Managed via the workspaces:set-order IPC (broadcasts settingsChanged to keep base fresh), not
    // this update path — so just carry it through.
    workspaceOrder: (partial as Partial<Settings>).workspaceOrder ?? base.workspaceOrder,
    // Preserve pluginCreds across saves — it's managed via the plugin IPC, not this update path.
    // Reading from the loaded settings on load (cast) and from base on regular updates.
    pluginCreds: (partial as Partial<Settings>).pluginCreds ?? base.pluginCreds,
    terminal: { ...base.terminal, ...(partial.terminal ?? {}) },
    lastActiveWorkspace: partial.lastActiveWorkspace ?? base.lastActiveWorkspace,
  }
}

export interface SettingsApi {
  settings: Settings | null
  update: (partial: SettingsUpdate) => void
}

export function useSettings(): SettingsApi {
  const [settings, setSettings] = useState<Settings | null>(null)
  const api = useRef(window.forge)

  useEffect(() => {
    let live = true
    void api.current.getSettings().then((s: Partial<Settings>) => {
      if (live) setSettings(merge(DEFAULTS, s ?? {}))
    })
    return () => { live = false }
  }, [])

  // 任一窗口写入 settings 后刷新本地快照，避免用过期快照覆盖其它窗口的改动（如宠物拖动写入的 pet.free）。
  useEffect(() => {
    const off = window.forge.onSettingsChanged((s) => {
      setSettings(merge(DEFAULTS, (s ?? {}) as Partial<Settings>))
    })
    return () => { off() }
  }, [])

  const update = useCallback((partial: SettingsUpdate) => {
    setSettings(prev => {
      const next = merge(prev ?? DEFAULTS, partial)
      void api.current.setSettings(next)
      return next
    })
  }, [])

  return { settings, update }
}
