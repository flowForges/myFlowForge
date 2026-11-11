// 模态打开时,整个 mff-ai 视图(rail、页头、以及之后才出现的兄弟)都 inert;每种模式一条。
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { UpgradeModal } from '../plugins/UpgradeModal'
import { AddAccountDrawer } from '../conn/AddAccountDrawer'
import { route } from '../route'
import { S, memStorage, mountPanel, act$, actBtn } from '../test/panel'

/** rail + (页头 + 页面框(.mffai-plugins(列表 + 槽))) 的外壳 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mffai-page" data-testid="page">
      <nav className="mffai-rail">rail</nav>
      <div className="mffai-main">
        <header className="mffai-head">head</header>
        <div className="mffai-pagebox">
          <div className="mffai-plugins"><div className="mffai-list">list</div><div data-testid="slot">{children}</div></div>
        </div>
      </div>
    </div>
  )
}
const inert = (sel: string) => (document.querySelector(sel) as HTMLElement).closest('[inert]') !== null

describe('modal scope: the whole mff-ai view is inert', () => {
  it('upgrade modal: rail, page header and the list are inert, also a sibling that appears later; all restored on close', async () => {
    function Host() {
      const [open, setOpen] = useState(true)
      return <Shell>{open && <UpgradeModal onClose={() => setOpen(false)}><button>x</button></UpgradeModal>}</Shell>
    }
    render(<Host />)
    for (const s of ['.mffai-rail', '.mffai-head', '.mffai-list']) expect(inert(s), s).toBe(true)
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()
    const late = document.createElement('div')
    late.className = 'mffai-late'
    document.querySelector('.mffai-plugins')!.appendChild(late)
    await waitFor(() => expect(late.hasAttribute('inert')).toBe(true))
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(document.querySelector('[inert]')).toBeNull()
    expect(late.hasAttribute('inert')).toBe(false)
  })

  it('add-account drawer: rail, header and the page are inert; the drawer and its dim are not; restored on close', () => {
    function Host() {
      const [open, setOpen] = useState(true)
      return <Shell><AddAccountDrawer open={open} onClose={() => setOpen(false)}><input /></AddAccountDrawer></Shell>
    }
    render(<Host />)
    for (const s of ['.mffai-rail', '.mffai-head', '.mffai-list']) expect(inert(s), s).toBe(true)
    expect(inert('aside.mffai-drawer')).toBe(false)
    expect(inert('.mffai-drawer-dim')).toBe(false)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('[inert]')).toBeNull()
  })
})

describe('activity drawer scope', () => {
  it('while the drawer is open the rail-side columns are inert, the drawer and its scrim are not; closing restores', async () => {
    vi.stubGlobal('localStorage', memStorage())
    route.set({ page: 'chat', sessionId: S })
    const m = await mountPanel(1100)
    try {
      fireEvent.click(actBtn())
      await waitFor(() => expect(act$()?.classList.contains('drawer')).toBe(true))
      expect(inert('.mffai-sesscol')).toBe(true)
      expect(inert('.mffai-chat-body')).toBe(true)
      expect(act$()!.closest('[inert]')).toBeNull()
      expect(inert('.mffai-scrim')).toBe(false)
      fireEvent.click(document.querySelector('.mffai-scrim')!)
      await waitFor(() => expect(act$()?.classList.contains('drawer') ?? false).toBe(false))
      expect(document.querySelector('[inert]')).toBeNull()
    } finally { m.done(); vi.unstubAllGlobals() }
  })
})
