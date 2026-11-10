import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { PageHeader, PAGE_TITLE } from './PageHeader'
import { HeaderExtra, HeaderSlotCtx } from './headerSlot'
import MffaiView from '../MffaiView'
import { MFFAI_PAGES, route } from '../route'
import { installFakeForge, type FakeForge } from '../test/fakeForge'

function Harness({ title, extra }: { title: string; extra: boolean }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <HeaderSlotCtx.Provider value={slot}>
      <PageHeader title={title} pill={<span data-testid="pill">pill</span>} slotRef={setSlot} />
      {extra && <HeaderExtra><b data-testid="extra">3 项</b></HeaderExtra>}
    </HeaderSlotCtx.Provider>
  )
}

describe('PageHeader', () => {
  it('a title per page, in the app\'s order', () => {
    expect(MFFAI_PAGES.map((p) => PAGE_TITLE[p])).toEqual(['对话', '任务', '记忆', '插件', '连接', '权限', '调试'])
  })

  it('header = title, slot, spring, pill', () => {
    render(<Harness title="任务" extra={false} />)
    const head = document.querySelector('header.mffai-head')!
    expect(head.querySelector('h1')!.textContent).toBe('任务')
    expect([...head.children].map((c) => c.className)).toEqual(['mffai-head-title', 'mffai-head-slot', 'mffai-head-spring', ''])
    expect(head.lastElementChild).toBe(screen.getByTestId('pill'))
  })

  it('HeaderExtra children land in the slot and leave with the component', () => {
    const r = render(<Harness title="任务" extra />)
    expect(screen.getByTestId('extra').closest('.mffai-head-slot')).not.toBeNull()
    r.rerender(<Harness title="任务" extra={false} />)
    expect(screen.queryByTestId('extra')).toBeNull()
    expect(document.querySelector('.mffai-head-slot')!.childElementCount).toBe(0)
  })

  it('HeaderExtra without a slot renders nothing', () => {
    render(<HeaderExtra><b data-testid="x">x</b></HeaderExtra>)
    expect(screen.queryByTestId('x')).toBeNull()
  })
})

describe('MffaiView header on every page', () => {
  let f: FakeForge
  beforeEach(() => {
    route.set({ page: 'chat' })
    f = installFakeForge({
      state: { proxyStale: true },
      calls: {
        status: {
          state: 'running', uptimeMs: 1, rssMb: 50, version: '0.1.0',
          plugins: [{ id: 'mine', state: 'active', trust: 'dev' }], problems: ['dev_crashed'], dbUnprotected: true, secretsBackend: 'plaintext-file',
        },
        'session.list': { sessions: [] },
        'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
        'models.catalog': { presets: [], models: {} },
        'models.accounts': { accounts: [], secretsBackend: 'keychain' },
        'events.tail': { events: [] },
      },
    })
  })

  for (const p of MFFAI_PAGES) {
    it(`${p}: title, pill and every warning in the header`, async () => {
      route.set({ page: p })
      render(<MffaiView />)
      await screen.findByTestId(`mffai-page-${p}`)
      const head = document.querySelector('header.mffai-head')!
      expect(head.querySelector('h1')!.textContent).toBe(PAGE_TITLE[p])
      expect(head.querySelector('.mffai-stpill')).not.toBeNull()
      for (const t of ['开发插件 · 完全访问', '开发插件已跳过', '数据库未收紧', '明文存储', '代理已改', '重启']) {
        await waitFor(() => expect(head).toHaveTextContent(t))
      }
      expect(f.mffai.restart).not.toHaveBeenCalled()
    })
  }

  it('the header 重启 is the same host restart', async () => {
    render(<MffaiView />)
    await screen.findByTestId('mffai-page-chat')
    const head = document.querySelector('header.mffai-head') as HTMLElement
    fireEvent.click([...head.querySelectorAll('button')].find((b) => b.textContent === '重启')!)
    expect(f.mffai.restart).toHaveBeenCalledTimes(1)
  })
})
