// Review Focus 9 第三条:面板在 SessionPane 的 ChatHtmlCtx=false、UntrustedMdCtx=true 里面渲染。
// RunCard 包一层探针:同一位置渲染 app 的 MdLink(不可信上下文里文字和地址不同的外链带 .md-link-host)并读 ChatHtmlCtx。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createElement, useContext, type ComponentProps } from 'react'
import { ChatHtmlCtx } from '../../views/chat/markdown'
import { MdLink } from '../../views/chat/MdLink'
import { MainWidthProvider } from '../useMainWidth'
import { route } from '../route'
import { resetSeq } from '../test/events'
import { installFakeForge } from '../test/fakeForge'
import { installResize } from '../test/resize'
import { S, act$, memStorage, panelCalls } from '../test/panel'
import ChatPage from './ChatPage'

vi.mock('./RunCard', async (orig) => {
  const m = await orig<typeof import('./RunCard')>()
  function Probe() {
    return createElement('span', { className: 'mffai-ctxprobe', 'data-html': String(useContext(ChatHtmlCtx)) },
      createElement(MdLink, { href: 'https://good.example/a', children: 'docs' }))
  }
  return { ...m, RunCard: (p: ComponentProps<typeof m.RunCard>) => createElement('div', null, createElement(Probe), createElement(m.RunCard, p)) }
})

let un: (() => void) | undefined
beforeEach(() => { resetSeq(); route.set({ page: 'chat', sessionId: S }); vi.stubGlobal('localStorage', memStorage()) })
afterEach(() => { un?.(); vi.unstubAllGlobals() })

describe('the panel sits inside the untrusted-content providers', () => {
  it('a markdown link rendered in the panel carries .md-link-host; inline HTML stays off even when the app turns it on', async () => {
    const r = installResize(); un = r.uninstall
    installFakeForge({ calls: panelCalls() })
    render(<ChatHtmlCtx.Provider value={true}><MainWidthProvider><ChatPage /></MainWidthProvider></ChatHtmlCtx.Provider>)
    r.setMainWidth(1440)
    await screen.findByText('fix the build')
    const probe = act$()!.querySelector('.mffai-ctxprobe')!
    expect(probe).not.toBeNull()
    expect(probe.getAttribute('data-html')).toBe('false')
    expect(probe.querySelector('.md-link-host')!.textContent).toBe('good.example')
  })
})
