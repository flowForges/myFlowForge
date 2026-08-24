import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings, Appearance, Pet, Terminal, CloseAction, AppIcon, Notifications, Keybindings } from '@shared/types'
import { builtinPets } from '@shared/builtinPets'

const DEFAULTS: Settings = {
  appearance: { theme: 'light', accent: 'blue', autoWallpaperTheme: false, vibrancy: false, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 14, chatFontSize: 14, chatLineHeight: 1.7, chatLetterSpacing: 0, chatInlineHtml: false, fontFamily: '', textWeight: 450, bgImage: '', bgScope: 'off', bgOpacity: 0.35, bgWallpaperId: '', homeBgImage: '', homeBgOn: false, homeBgOpacity: 0.35, bgPositions: {} },
  notifications: { enabled: true, confirm: true, input: true, done: true },
  notifyEvents: { confirm: true, input: true, done: true },
  closeAction: 'ask',
  appIcon: { dockIcon: 'ember-violet', showMenuBar: false },
  agentProxy: '',
  appProxy: '',
  skills: { 'code-review': true, 'test-driven': true, 'deep-research': false, 'systematic-debugging': true },
  pet: { enabled: true, skin: 'ghost', customPets: builtinPets(), activeCustomPetId: undefined, corner: 'right', pos: { bottom: 24 }, followCursor: true, idleAnimation: true, scale: 1, notify: { confirm: true, input: true, done: false }, interactionMode: 'simple', states: { idle: { anim: 'float', accent: 'none' }, working: { anim: 'spin-halo', accent: 'none' }, confirm: { anim: 'alert', accent: 'warn' }, input: { anim: 'tilt', accent: 'accent' }, done: { anim: 'pulse-ok', accent: 'ok' } } },
  heartbeat: { stallMs: 90_000, killGraceMs: 60_000, pingMs: 15_000 },
  pinnedWorkspaces: [],
  workspaceOrder: [],
  lastActiveWorkspace: {},
  pluginCreds: {},
  disabledProviders: [],
  terminal: { fontFamily: "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace", fontSize: 12.5 },
  defaultOpenerId: '',
  keybindings: { overrides: {} },
  perfStallToast: false,
  perfDiagnostics: false,
  nsfwUnlocked: false,
  nsfwCode: '',
  nsfwCodes: [],
  nsfwInstalled: {},
  fullAccessAck: {},
  memory: { enabled: true },
  botBridge: { dingtalk: { enabled: false, clientId: '', clientSecret: '' }, telegram: { enabled: false, botToken: '' }, feishu: { enabled: false, appId: '', appSecret: '' }, verbosity: 'essential', pairingCode: '', bindings: [], ids: { seq: 0, ws: {}, session: {} } },
  codexTransport: 'exec',
  mobileGateway: { enabled: false, host: '0.0.0.0', port: 6789 },
}

export interface SettingsUpdate {
  appearance?: Partial<Appearance>
  notifications?: Partial<Notifications>
  closeAction?: CloseAction
  appIcon?: Partial<AppIcon>
  agentProxy?: string
  appProxy?: string
  notifyEvents?: Settings['notifyEvents']
  skills?: Record<string, boolean>
  pet?: Partial<Pet>
  heartbeat?: Settings['heartbeat']
  terminal?: Partial<Terminal>
  lastActiveWorkspace?: Record<string, string>
  defaultOpenerId?: string
  keybindings?: Keybindings
  perfStallToast?: boolean
  perfDiagnostics?: boolean
  disabledProviders?: string[]
  nsfwUnlocked?: boolean
  nsfwCode?: string
  nsfwCodes?: string[]
  nsfwInstalled?: Record<string, string>
  memory?: { enabled: boolean }
  botBridge?: Settings['botBridge']
}

function merge(base: Settings, partial: SettingsUpdate): Settings {
  return {
    appearance: { ...base.appearance, ...(partial.appearance ?? {}) },
    notifications: { ...base.notifications, ...(partial.notifications ?? {}) },
    notifyEvents: { ...base.notifyEvents, ...(partial.notifyEvents ?? {}) },
    closeAction: partial.closeAction ?? base.closeAction,
    appIcon: { ...base.appIcon, ...(partial.appIcon ?? {}) },
    agentProxy: partial.agentProxy ?? base.agentProxy,
    appProxy: partial.appProxy ?? base.appProxy,
    skills: { ...base.skills, ...(partial.skills ?? {}) },
    pet: { ...base.pet, ...(partial.pet ?? {}) },
    heartbeat: partial.heartbeat ?? base.heartbeat,
    // Both pinnedWorkspaces and workspaceOrder are managed via dedicated workspaces:* IPC (each
    // broadcasts settingsChanged to keep base fresh), never this update path. Read from `partial`
    // first so a fresh load / broadcast picks up the on-disk value; otherwise DEFAULTS ([]) would
    // shadow it on load and every later config:set-settings would clobber the pins back to [].
    pinnedWorkspaces: (partial as Partial<Settings>).pinnedWorkspaces ?? base.pinnedWorkspaces,
    workspaceOrder: (partial as Partial<Settings>).workspaceOrder ?? base.workspaceOrder,
    // Preserve pluginCreds across saves — it's managed via the plugin IPC, not this update path.
    // Reading from the loaded settings on load (cast) and from base on regular updates.
    pluginCreds: (partial as Partial<Settings>).pluginCreds ?? base.pluginCreds,
    disabledProviders: partial.disabledProviders ?? base.disabledProviders,
    terminal: { ...base.terminal, ...(partial.terminal ?? {}) },
    lastActiveWorkspace: partial.lastActiveWorkspace ?? base.lastActiveWorkspace,
    defaultOpenerId: partial.defaultOpenerId ?? base.defaultOpenerId,
    keybindings: partial.keybindings ?? base.keybindings ?? { overrides: {} },
    perfStallToast: partial.perfStallToast ?? base.perfStallToast,
    perfDiagnostics: partial.perfDiagnostics ?? base.perfDiagnostics,
    nsfwUnlocked: partial.nsfwUnlocked ?? base.nsfwUnlocked,
    nsfwCode: partial.nsfwCode ?? base.nsfwCode,
    nsfwCodes: partial.nsfwCodes ?? base.nsfwCodes,
    nsfwInstalled: partial.nsfwInstalled ?? base.nsfwInstalled,
    // Not managed via this update path (see ackFullAccess in config/store.ts) — preserve from the
    // loaded settings on load (cast), else keep base, matching pluginCreds/pinnedWorkspaces above.
    fullAccessAck: (partial as Partial<Settings>).fullAccessAck ?? base.fullAccessAck,
    memory: { ...base.memory, ...(partial.memory ?? {}) },
    // Managed via the bot:* IPC (connect/regen-pairing/unbind each write settings + broadcast), not
    // this update path — preserve from the loaded settings on load (cast), else base, like pluginCreds.
    botBridge: (partial as Partial<Settings>).botBridge ?? base.botBridge,
    codexTransport: (partial as Partial<Settings>).codexTransport ?? base.codexTransport,
    mobileGateway: { ...base.mobileGateway, ...((partial as Partial<Settings>).mobileGateway ?? {}) },
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
