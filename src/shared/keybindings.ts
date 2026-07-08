// Keybinding system — single source of truth for the app's shortcut actions plus the pure helpers
// that parse / match / format Electron "accelerator" strings. Imported by BOTH the main process
// (global shortcuts) and the renderer (in-app keydown dispatcher + settings pane), so this file must
// stay free of electron/DOM runtime deps (the KeyboardEvent type is a TS lib type, erased at build).

export type KeyScope = 'global' | 'app'
export type Platform = 'darwin' | 'other'

export interface ActionDef {
  id: string
  label: string
  desc: string
  scope: KeyScope
  group: string
  defaultAccel: string // Electron accelerator, e.g. 'CommandOrControl+Shift+P' ('' = unbound by default)
}

// The registry IS the single source of truth. settings.json only stores user OVERRIDES keyed by id,
// so adding an action here gives every existing user its default binding with no migration.
export const KEYBINDING_ACTIONS: ActionDef[] = [
  // ── 系统级(全局,后台也生效) ──────────────────────────────────────────────
  { id: 'toggle-main-window', scope: 'global', group: '全局', label: '显示 / 隐藏主窗口', desc: '一键从后台唤起主窗口,或再次按下收起', defaultAccel: 'CommandOrControl+Alt+F' },
  { id: 'toggle-pet', scope: 'global', group: '全局', label: '显示 / 隐藏宠物', desc: '切换桌面宠物窗口的可见性', defaultAccel: 'CommandOrControl+Shift+P' },
  // ── 应用内(仅主窗口聚焦时生效) ──────────────────────────────────────────
  { id: 'new-workspace', scope: 'app', group: '工作区与会话', label: '新建工作区', desc: '打开新建工作区向导', defaultAccel: 'CommandOrControl+N' },
  { id: 'new-session', scope: 'app', group: '工作区与会话', label: '新建会话', desc: '在当前工作区开一个新会话', defaultAccel: 'CommandOrControl+T' },
  { id: 'prev-session', scope: 'app', group: '工作区与会话', label: '上一个会话', desc: '切换到当前工作区的上一个会话', defaultAccel: 'CommandOrControl+Alt+Up' },
  { id: 'next-session', scope: 'app', group: '工作区与会话', label: '下一个会话', desc: '切换到当前工作区的下一个会话', defaultAccel: 'CommandOrControl+Alt+Down' },
  { id: 'prev-workspace', scope: 'app', group: '工作区与会话', label: '上一个工作区', desc: '切换到侧栏中的上一个工作区', defaultAccel: 'CommandOrControl+Alt+Left' },
  { id: 'next-workspace', scope: 'app', group: '工作区与会话', label: '下一个工作区', desc: '切换到侧栏中的下一个工作区', defaultAccel: 'CommandOrControl+Alt+Right' },
  { id: 'toggle-terminal', scope: 'app', group: '面板', label: '开关终端', desc: '展开 / 收起底部终端面板', defaultAccel: 'Control+`' },
  { id: 'toggle-log', scope: 'app', group: '面板', label: '开关实时日志', desc: '展开 / 收起底部实时日志台', defaultAccel: 'CommandOrControl+Shift+J' },
  { id: 'toggle-sidebar', scope: 'app', group: '面板', label: '折叠 / 展开侧栏', desc: '收起或展开左侧工作区侧栏', defaultAccel: 'CommandOrControl+B' },
  { id: 'toggle-inspector', scope: 'app', group: '面板', label: '折叠 / 展开检查器', desc: '收起或展开右侧检查器', defaultAccel: 'CommandOrControl+Alt+B' },
  { id: 'toggle-settings', scope: 'app', group: '导航', label: '打开 / 关闭设置', desc: '打开或关闭设置面板', defaultAccel: 'CommandOrControl+,' },
  { id: 'open-plugins', scope: 'app', group: '导航', label: '打开插件设置', desc: '直接跳到设置的插件页', defaultAccel: 'CommandOrControl+Shift+I' },
]

export const GLOBAL_ACTIONS = KEYBINDING_ACTIONS.filter(a => a.scope === 'global')
export const APP_ACTIONS = KEYBINDING_ACTIONS.filter(a => a.scope === 'app')

export interface ParsedAccel { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; key: string }

// Modifier token → which flag(s) it sets. 'CommandOrControl' is platform-dependent, resolved in parse.
const MOD_TOKENS: Record<string, 'ctrl' | 'meta' | 'alt' | 'shift' | 'cmdOrCtrl'> = {
  commandorcontrol: 'cmdOrCtrl', cmdorctrl: 'cmdOrCtrl',
  command: 'meta', cmd: 'meta', super: 'meta', meta: 'meta', win: 'meta',
  control: 'ctrl', ctrl: 'ctrl',
  alt: 'alt', option: 'alt',
  shift: 'shift',
}

// Split an accelerator into its modifier tokens (normalized lowercase) and the final key token (raw).
function splitAccel(accel: string): { mods: string[]; key: string } {
  const parts = accel.split('+').map(p => p.trim()).filter(Boolean)
  if (!parts.length) return { mods: [], key: '' }
  // A trailing '+' means the key itself is '+' (e.g. 'CommandOrControl++').
  const key = accel.trimEnd().endsWith('+') ? '+' : parts[parts.length - 1]
  const modParts = accel.trimEnd().endsWith('+') ? parts : parts.slice(0, -1)
  const mods = modParts.filter(p => MOD_TOKENS[p.toLowerCase()] !== undefined).map(p => p.toLowerCase())
  return { mods, key }
}

// Normalize a key token to a canonical comparison form: single letters uppercased, arrows/space/etc named.
export function normalizeKeyToken(raw: string): string {
  if (!raw) return ''
  const k = raw.length === 1 ? raw.toUpperCase() : raw
  const map: Record<string, string> = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Esc: 'Escape', Return: 'Enter', ' ': 'Space', Spacebar: 'Space',
  }
  return map[k] ?? k
}

export function parseAccelerator(accel: string, platform: Platform): ParsedAccel | null {
  const { mods, key } = splitAccel(accel)
  if (!key) return null
  const p: ParsedAccel = { ctrl: false, meta: false, alt: false, shift: false, key: normalizeKeyToken(key) }
  for (const m of mods) {
    const kind = MOD_TOKENS[m]
    if (kind === 'cmdOrCtrl') { if (platform === 'darwin') p.meta = true; else p.ctrl = true }
    else if (kind === 'ctrl') p.ctrl = true
    else if (kind === 'meta') p.meta = true
    else if (kind === 'alt') p.alt = true
    else if (kind === 'shift') p.shift = true
  }
  return p
}

// A minimal shape of the fields we read off a keydown event — keeps this file DOM-free while accepting
// a real KeyboardEvent.
export interface KeyLike { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'OS'])

// Canonical key of an event, preferring event.key but falling back to physical code for cases where
// modifiers rewrite key (e.g. Alt on mac). Returns '' for a bare modifier press.
export function eventKey(e: KeyLike): string {
  if (MODIFIER_KEYS.has(e.key)) return ''
  if (e.key && e.key !== 'Dead' && e.key !== 'Unidentified') return normalizeKeyToken(e.key)
  // Fallback: derive from physical code (KeyA → A, Digit1 → 1, Backquote → `).
  const c = e.code ?? ''
  if (/^Key[A-Z]$/.test(c)) return c.slice(3)
  if (/^Digit[0-9]$/.test(c)) return c.slice(5)
  const codeMap: Record<string, string> = { Backquote: '`', Comma: ',', Period: '.', Slash: '/', Space: 'Space' }
  return codeMap[c] ?? ''
}

export function matchesEvent(accel: string, e: KeyLike, platform: Platform): boolean {
  const p = parseAccelerator(accel, platform)
  if (!p) return false
  const key = eventKey(e)
  if (!key) return false
  return p.ctrl === e.ctrlKey && p.meta === e.metaKey && p.alt === e.altKey && p.shift === e.shiftKey &&
    p.key.toLowerCase() === key.toLowerCase()
}

// Build a concrete accelerator string from a keydown event (recording UX). Records LITERAL modifiers
// (Command on mac, Control elsewhere) — matchesEvent still matches these and the CommandOrControl
// defaults alike. Returns null for a bare modifier press so recording waits for a real key.
export function eventToAccelerator(e: KeyLike, platform: Platform): string | null {
  const key = eventKey(e)
  if (!key) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.metaKey) mods.push(platform === 'darwin' ? 'Command' : 'Meta')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  return [...mods, key].join('+')
}

// Human display of an accelerator. mac → compact symbols (⌘⇧P); other → 'Ctrl+Shift+P'.
export function formatAccelerator(accel: string, platform: Platform): string {
  if (!accel) return ''
  const { mods, key } = splitAccel(accel)
  const dispKey = ({ Up: '↑', Down: '↓', Left: '←', Right: '→', Space: '␣', Enter: '⏎', Escape: 'Esc' } as Record<string, string>)[normalizeKeyToken(key)] ?? normalizeKeyToken(key)
  if (platform === 'darwin') {
    const sym: Record<string, string> = { cmdOrCtrl: '⌘', meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
    const order = ['ctrl', 'alt', 'shift', 'cmdOrCtrl', 'meta']
    const present = mods.map(m => MOD_TOKENS[m])
    const parts = order.filter(o => present.includes(o as any)).map(o => sym[o])
    return parts.join('') + dispKey
  }
  const label: Record<string, string> = { cmdOrCtrl: 'Ctrl', meta: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }
  const order = ['cmdOrCtrl', 'ctrl', 'meta', 'alt', 'shift']
  const present = mods.map(m => MOD_TOKENS[m])
  const parts = order.filter(o => present.includes(o as any)).map(o => label[o])
  return [...parts, dispKey].join('+')
}

// True when the accelerator has a NON-shift modifier (Ctrl/Cmd/Alt). Shift-only or bare keys return
// false — those risk clashing with plain typing, so the pane warns and the dispatcher skips them in inputs.
export function hasModifier(accel: string): boolean {
  const { mods } = splitAccel(accel)
  return mods.some(m => { const k = MOD_TOKENS[m]; return k === 'ctrl' || k === 'meta' || k === 'alt' || k === 'cmdOrCtrl' })
}

// Merge registry defaults with user overrides. override === '' means explicitly unbound. Absent → default.
export function effectiveBindings(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of KEYBINDING_ACTIONS) {
    out[a.id] = Object.prototype.hasOwnProperty.call(overrides, a.id) ? overrides[a.id] : a.defaultAccel
  }
  return out
}

// Group effective bindings by accelerator to find in-app duplicates (ignoring unbound/empty).
export function findDuplicates(effective: Record<string, string>): Map<string, string[]> {
  const byAccel = new Map<string, string[]>()
  for (const [id, accel] of Object.entries(effective)) {
    if (!accel) continue
    const list = byAccel.get(accel) ?? []
    list.push(id)
    byAccel.set(accel, list)
  }
  const dups = new Map<string, string[]>()
  for (const [accel, ids] of byAccel) if (ids.length > 1) dups.set(accel, ids)
  return dups
}
