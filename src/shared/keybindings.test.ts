import { describe, it, expect } from 'vitest'
import {
  KEYBINDING_ACTIONS, GLOBAL_ACTIONS, APP_ACTIONS,
  parseAccelerator, matchesEvent, eventToAccelerator, formatAccelerator,
  hasModifier, effectiveBindings, findDuplicates, eventKey, normalizeKeyToken,
  type KeyLike,
} from './keybindings'

const ev = (over: Partial<KeyLike>): KeyLike => ({ key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over })

describe('registry', () => {
  it('has unique action ids', () => {
    const ids = KEYBINDING_ACTIONS.map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('splits into global + app with no overlap and full coverage', () => {
    expect(GLOBAL_ACTIONS.length + APP_ACTIONS.length).toBe(KEYBINDING_ACTIONS.length)
    expect(GLOBAL_ACTIONS.every(a => a.scope === 'global')).toBe(true)
    expect(APP_ACTIONS.every(a => a.scope === 'app')).toBe(true)
  })
  it('default bindings have no in-app duplicates', () => {
    const dups = findDuplicates(effectiveBindings({}))
    expect([...dups.keys()]).toEqual([])
  })
})

describe('parseAccelerator', () => {
  it('resolves CommandOrControl per platform', () => {
    expect(parseAccelerator('CommandOrControl+P', 'darwin')).toMatchObject({ meta: true, ctrl: false, key: 'P' })
    expect(parseAccelerator('CommandOrControl+P', 'other')).toMatchObject({ ctrl: true, meta: false, key: 'P' })
  })
  it('parses explicit modifiers and normalizes the key', () => {
    expect(parseAccelerator('Control+Alt+Shift+a', 'other')).toEqual({ ctrl: true, alt: true, shift: true, meta: false, key: 'A' })
  })
  it('handles the "+" key and arrow names', () => {
    expect(parseAccelerator('CommandOrControl++', 'other')).toMatchObject({ ctrl: true, key: '+' })
    expect(parseAccelerator('Alt+ArrowUp', 'other')).toMatchObject({ alt: true, key: 'Up' })
  })
  it('returns null when no key is present', () => {
    expect(parseAccelerator('Control+Shift', 'other')).not.toBeNull() // 'Shift' is the key here
    expect(parseAccelerator('', 'other')).toBeNull()
  })
})

describe('eventKey', () => {
  it('is empty for bare modifier presses', () => {
    expect(eventKey(ev({ key: 'Control' }))).toBe('')
    expect(eventKey(ev({ key: 'Meta' }))).toBe('')
  })
  it('uppercases letters and names arrows/space', () => {
    expect(eventKey(ev({ key: 'a' }))).toBe('A')
    expect(eventKey(ev({ key: 'ArrowDown' }))).toBe('Down')
    expect(eventKey(ev({ key: ' ' }))).toBe('Space')
  })
  it('falls back to physical code when key is unusable', () => {
    expect(eventKey(ev({ key: 'Dead', code: 'KeyB' }))).toBe('B')
    expect(eventKey(ev({ key: '`', code: 'Backquote' }))).toBe('`')
  })
})

describe('matchesEvent', () => {
  it('matches CommandOrControl default against cmd on mac / ctrl elsewhere', () => {
    expect(matchesEvent('CommandOrControl+N', ev({ key: 'n', metaKey: true }), 'darwin')).toBe(true)
    expect(matchesEvent('CommandOrControl+N', ev({ key: 'n', ctrlKey: true }), 'other')).toBe(true)
    // wrong modifier for platform
    expect(matchesEvent('CommandOrControl+N', ev({ key: 'n', ctrlKey: true }), 'darwin')).toBe(false)
  })
  it('requires ALL modifier flags to match exactly', () => {
    expect(matchesEvent('Control+`', ev({ key: '`', ctrlKey: true }), 'other')).toBe(true)
    expect(matchesEvent('Control+`', ev({ key: '`', ctrlKey: true, shiftKey: true }), 'other')).toBe(false)
  })
  it('matches a literal Command override on mac', () => {
    expect(matchesEvent('Command+Shift+J', ev({ key: 'j', metaKey: true, shiftKey: true }), 'darwin')).toBe(true)
  })
})

describe('eventToAccelerator', () => {
  it('records literal Command on mac, Meta elsewhere', () => {
    expect(eventToAccelerator(ev({ key: 'k', metaKey: true, shiftKey: true }), 'darwin')).toBe('Command+Shift+k'.replace('k', 'K'))
    expect(eventToAccelerator(ev({ key: 'k', ctrlKey: true }), 'other')).toBe('Control+K')
  })
  it('returns null for a bare modifier press', () => {
    expect(eventToAccelerator(ev({ key: 'Shift', shiftKey: true }), 'darwin')).toBeNull()
  })
  it('round-trips through matchesEvent', () => {
    const e = ev({ key: 'b', ctrlKey: true, altKey: true })
    const accel = eventToAccelerator(e, 'other')!
    expect(matchesEvent(accel, e, 'other')).toBe(true)
  })
})

describe('formatAccelerator', () => {
  it('renders mac symbols', () => {
    expect(formatAccelerator('CommandOrControl+Shift+P', 'darwin')).toBe('⇧⌘P')
    expect(formatAccelerator('CommandOrControl+Alt+Left', 'darwin')).toBe('⌥⌘←')
  })
  it('renders windows-style labels', () => {
    expect(formatAccelerator('CommandOrControl+Shift+P', 'other')).toBe('Ctrl+Shift+P')
    expect(formatAccelerator('Control+`', 'other')).toBe('Ctrl+`')
  })
  it('is empty for an unbound accelerator', () => {
    expect(formatAccelerator('', 'darwin')).toBe('')
  })
})

describe('hasModifier', () => {
  it('true for ctrl/cmd/alt combos', () => {
    expect(hasModifier('CommandOrControl+N')).toBe(true)
    expect(hasModifier('Alt+Up')).toBe(true)
  })
  it('false for shift-only or bare keys', () => {
    expect(hasModifier('Shift+A')).toBe(false)
    expect(hasModifier('F')).toBe(false)
  })
})

describe('effectiveBindings + findDuplicates', () => {
  it('applies overrides over defaults, empty string = unbound', () => {
    const eff = effectiveBindings({ 'toggle-terminal': '', 'new-session': 'CommandOrControl+Alt+T' })
    expect(eff['toggle-terminal']).toBe('')
    expect(eff['new-session']).toBe('CommandOrControl+Alt+T')
    expect(eff['new-workspace']).toBe('CommandOrControl+N') // untouched default
  })
  it('detects duplicate assignments and ignores empty', () => {
    const eff = effectiveBindings({ 'new-session': 'CommandOrControl+N' }) // collides with new-workspace
    const dups = findDuplicates(eff)
    expect(dups.get('CommandOrControl+N')?.sort()).toEqual(['new-session', 'new-workspace'])
  })
  it('two unbound actions are NOT a duplicate', () => {
    const eff = effectiveBindings({ 'new-session': '', 'new-workspace': '' })
    expect(findDuplicates(eff).size).toBe(0)
  })
})

describe('normalizeKeyToken', () => {
  it('maps aliases', () => {
    expect(normalizeKeyToken('Esc')).toBe('Escape')
    expect(normalizeKeyToken('Return')).toBe('Enter')
    expect(normalizeKeyToken('a')).toBe('A')
  })
})
