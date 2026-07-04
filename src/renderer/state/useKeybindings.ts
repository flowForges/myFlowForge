import { useEffect, useRef } from 'react'
import { APP_ACTIONS, matchesEvent, hasModifier, effectiveBindings, type Platform } from '@shared/keybindings'

export const rendererPlatform = (): Platform =>
  (typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)) ? 'darwin' : 'other'

const isEditable = (el: EventTarget | null): boolean => {
  const n = el as HTMLElement | null
  if (!n || !n.tagName) return false
  const tag = n.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || n.isContentEditable === true
}

// Central in-app shortcut dispatcher: one window keydown listener that matches scope==='app' bindings
// and fires the matching handler. Bindings whose accelerator has no real modifier are skipped while a
// text field is focused (so plain typing never triggers them). The listener mounts once; latest
// overrides/handlers are read via a ref so we don't re-bind on every render.
export function useKeybindings(overrides: Record<string, string>, handlers: Record<string, () => void>) {
  const ref = useRef({ overrides, handlers })
  ref.current = { overrides, handlers }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { overrides, handlers } = ref.current
      const eff = effectiveBindings(overrides)
      const editable = isEditable(e.target)
      const platform = rendererPlatform()
      for (const a of APP_ACTIONS) {
        const accel = eff[a.id]
        if (!accel) continue
        if (editable && !hasModifier(accel)) continue
        if (!matchesEvent(accel, e, platform)) continue
        const h = handlers[a.id]
        if (!h) continue
        e.preventDefault()
        h()
        break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
