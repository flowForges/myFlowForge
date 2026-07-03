// Lightweight centred toast for import summaries (1:1 with the prototype showFlash). Appends a
// `.imp-flash` element that auto-removes after its CSS animation.
export function flashToast(msg: string): void {
  if (typeof document === 'undefined') return
  const el = document.createElement('div')
  el.className = 'imp-flash'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2600)
}
