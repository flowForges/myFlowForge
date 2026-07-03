import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The frameless titlebar is a `-webkit-app-region: drag` region so the window can be moved by
// dragging it. Any interactive surface RENDERED INSIDE the titlebar subtree (the notification
// popover panel, the usage popover) must opt back OUT with `no-drag`, or the OS eats clicks on it
// for window-dragging and the panel "won't open / can't be clicked". Buttons already get no-drag;
// the popover PANELS (divs) do not inherit it, so they need an explicit rule.
const globalCss = readFileSync(join(__dirname, 'global.css'), 'utf8')

describe('titlebar drag-region opt-outs', () => {
  it('marks the notification + usage popovers as no-drag', () => {
    const noDrag = globalCss.match(/-webkit-app-region:\s*no-drag/g) ?? []
    expect(noDrag.length).toBeGreaterThan(0)
    // The popover panels must be covered by a no-drag rule (whole subtree is interactive).
    expect(globalCss).toMatch(/\.notif-pop[^{]*\{[^}]*-webkit-app-region:\s*no-drag/s)
  })
})
