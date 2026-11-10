import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ConnectionsPage from './ConnectionsPage'
import { installFakeForge, type FakeForge } from '../test/fakeForge'
import { tgCalls } from '../test/telegram'

let f: FakeForge

describe('ConnectionsPage', () => {
  it('defaults to 模型, with the three sub-tabs; 模型 shows the account list', async () => {
    f = installFakeForge()
    f.mffai.models.catalog.mockResolvedValue({ presets: [], models: {} })
    f.mffai.models.accounts.mockResolvedValue({ accounts: [{ id: 'a1', presetId: 'p', label: 'acc1', state: 'ok' }], secretsBackend: 'keychain' })
    render(<ConnectionsPage />)
    expect(screen.getByRole('tab', { name: '模型' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '执行器' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'Telegram' })).toHaveAttribute('aria-selected', 'false')
    expect(await screen.findByText('acc1')).toBeInTheDocument()
  })

  it('switches to 执行器 and shows its rows', async () => {
    f = installFakeForge({ calls: {
      'executor.list': { executors: [{ id: 'claude', installed: true, version: '1.0.0', auth: 'ok', isolation: 'own', missing: [] }] },
    } })
    f.mffai.models.catalog.mockResolvedValue({ presets: [], models: {} })
    f.mffai.models.accounts.mockResolvedValue({ accounts: [], secretsBackend: 'keychain' })
    render(<ConnectionsPage />)
    fireEvent.click(screen.getByRole('tab', { name: '执行器' }))
    expect(await screen.findByText('claude')).toBeInTheDocument()
  })

  it('switches to Telegram and shows its status, not the model list', async () => {
    f = installFakeForge({ calls: tgCalls() })
    f.mffai.models.catalog.mockResolvedValue({ presets: [], models: {} })
    f.mffai.models.accounts.mockResolvedValue({ accounts: [{ id: 'a1', presetId: 'p', label: 'acc1', state: 'ok' }], secretsBackend: 'keychain' })
    render(<ConnectionsPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Telegram' }))
    expect(await screen.findByTestId('mffai-tg-status')).toBeInTheDocument()
    expect(screen.queryByText('acc1')).toBeNull()
  })

  it('the tabs are underline tabs with an icon each', () => {
    f = installFakeForge()
    render(<ConnectionsPage />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['模型', '执行器', 'Telegram'])
    for (const t of tabs) expect(t.querySelector('svg.mffai-i')).not.toBeNull()
    expect(screen.getByRole('tablist')).toHaveClass('mffai-tabs')
  })

  describe('模型 tab', () => {
    const preset = (id: string, label: string, auth = 'api-key') => ({ id, label, billing: 'metered', restriction: 'none', auth, protocols: [], docsUrl: '' })
    const m = (id: string, name: string) => ({ id, name, context: 1, output: 1, image: false, reasoning: 'none', toolCall: true })
    const setup = (accounts: unknown[], quota: (id: string) => unknown, backend = 'keychain') => {
      f = installFakeForge()
      f.mffai.models.catalog.mockResolvedValue({
        presets: [preset('anthropic', 'Anthropic'), preset('openai', 'OpenAI'), preset('deepseek', 'DeepSeek'), preset('chatgpt', 'ChatGPT 订阅', 'chatgpt-oauth')],
        models: { anthropic: [m('m1', 'M1'), m('m2', 'M2')] }, default: { accountId: 'a1', modelId: 'm2' },
      } as never)
      f.mffai.models.accounts.mockResolvedValue({ accounts, secretsBackend: backend } as never)
      f.mffai.models.quota.mockImplementation(async (id: string) => quota(id) as never)
    }

    it('header: 账号 N, the 钥匙串 chip and 添加账号', async () => {
      setup([{ id: 'a1', presetId: 'anthropic', label: 'acc1', state: 'ok' }, { id: 'a2', presetId: 'openai', label: 'acc2', state: 'ok' }], () => null)
      render(<ConnectionsPage />)
      await screen.findByText('acc1')
      const head = document.querySelector('.mffai-sech') as HTMLElement
      expect(head).toHaveTextContent('账号')
      expect(within(head).getByText('2')).toBeInTheDocument()
      expect(within(head).getByText('钥匙串')).toBeInTheDocument()
      expect(within(head).getByRole('button', { name: '添加账号' })).toBeInTheDocument()
    })

    it('the 钥匙串 chip is not shown for a plaintext or unavailable backend', async () => {
      setup([{ id: 'a1', presetId: 'anthropic', label: 'acc1', state: 'ok' }], () => null, 'plaintext-file')
      render(<ConnectionsPage />)
      await screen.findByText('acc1')
      expect(screen.queryByText('钥匙串')).toBeNull()
      expect(screen.getByText('明文存储')).toBeInTheDocument()
    })

    it('cards in a grid: logo tile tinted by preset, default star chip, state chip, preset chip', async () => {
      setup([
        { id: 'a1', presetId: 'anthropic', label: 'acc1', state: 'ok' },
        { id: 'a2', presetId: 'deepseek', label: 'acc2', state: 'quota_exhausted' },
        { id: 'a3', presetId: 'something-else', label: 'acc3', state: 'error' },
      ], () => null)
      render(<ConnectionsPage />)
      await screen.findByText('acc3')
      const grid = document.querySelector('.mffai-agrid') as HTMLElement
      const cards = grid.querySelectorAll('.mffai-acard')
      expect(cards).toHaveLength(3)
      const c1 = (screen.getByText('acc1').closest('.mffai-acard')) as HTMLElement
      expect(c1.querySelector('.mffai-alogo')).toHaveClass('anth')
      expect(c1.querySelector('.mffai-alogo')).toHaveTextContent('A')
      expect(within(c1).getByText('默认').closest('.mffai-chip')).toHaveClass('acc')
      expect(within(c1).getByText('Anthropic')).toBeInTheDocument()
      expect(within(c1).getByText('可用').closest('.mffai-chip')).toHaveClass('ok')
      const c2 = screen.getByText('acc2').closest('.mffai-acard') as HTMLElement
      expect(c2.querySelector('.mffai-alogo')).toHaveClass('ds')
      expect(within(c2).getByText('额度用尽').closest('.mffai-chip')).toHaveClass('bad')
      expect(within(c2).queryByText('默认')).toBeNull()
      expect(screen.getByText('acc3').closest('.mffai-acard')!.querySelector('.mffai-alogo')).toHaveClass('def')
    })

    it('quota meters: label, a bar whose fill width is usedPercent %, the percent; the text 5h 42% stays; above 80 is warn', async () => {
      setup([{ id: 'a1', presetId: 'anthropic', label: 'acc1', state: 'ok' }], () => ({ windows: [{ label: '5h', usedPercent: 42 }, { label: '周', usedPercent: 91 }] }))
      render(<ConnectionsPage />)
      expect(await screen.findByText('5h 42%')).toBeInTheDocument()
      const rows = document.querySelectorAll('.mffai-qrow')
      expect(rows).toHaveLength(2)
      expect((rows[0].querySelector('.mffai-qfill') as HTMLElement).style.width).toBe('42%')
      expect((rows[1].querySelector('.mffai-qfill') as HTMLElement).style.width).toBe('91%')
      expect(rows[0]).not.toHaveClass('warn')
      expect(rows[1]).toHaveClass('warn')
      expect(rows[0].querySelector('[role="meter"]')).toHaveAttribute('aria-valuenow', '42')
    })

    it('a quota above 100 or below 0 is clamped in the bar, not in the text', async () => {
      setup([{ id: 'a1', presetId: 'anthropic', label: 'acc1', state: 'ok' }], () => ({ windows: [{ label: '月', usedPercent: 130 }] }))
      render(<ConnectionsPage />)
      expect(await screen.findByText('月 130%')).toBeInTheDocument()
      expect((document.querySelector('.mffai-qfill') as HTMLElement).style.width).toBe('100%')
    })

    it('a link quota is the 用量 button and opens the link', async () => {
      setup([{ id: 'a1', presetId: 'anthropic', label: 'acc1', state: 'ok' }], () => ({ link: 'https://x/usage' }))
      render(<ConnectionsPage />)
      fireEvent.click(await screen.findByRole('button', { name: '用量' }))
      expect(f.mffai.openExternal).toHaveBeenCalledWith('https://x/usage')
    })

    it('delete is an icon button, still reachable as 删除, and removes that account at once', async () => {
      setup([{ id: 'a1', presetId: 'anthropic', label: 'acc1', state: 'ok' }], () => null)
      f.mffai.models.removeAccount.mockResolvedValue({ ok: true } as never)
      render(<ConnectionsPage />)
      await screen.findByText('acc1')
      const card = screen.getByText('acc1').closest('.mffai-acard') as HTMLElement
      const btn = within(card).getByRole('button', { name: '删除' })
      expect(btn.querySelector('svg.mffai-i')).not.toBeNull()
      fireEvent.click(btn)
      await waitFor(() => expect(f.mffai.models.removeAccount).toHaveBeenCalledWith('a1'))
    })

    it('默认模型 select and 设为默认 per card; the default card has it disabled', async () => {
      setup([{ id: 'a1', presetId: 'anthropic', label: 'acc1', state: 'ok' }], () => null)
      f.mffai.models.setDefault.mockResolvedValue({ ok: true } as never)
      render(<ConnectionsPage />)
      await screen.findByText('acc1')
      const sel = screen.getByRole('combobox', { name: '默认模型' }) as HTMLSelectElement
      expect(sel.value).toBe('m2')
      expect(screen.getByRole('button', { name: '设为默认' })).toBeDisabled()
      fireEvent.change(sel, { target: { value: 'm1' } })
      expect(screen.getByRole('button', { name: '设为默认' })).toBeDisabled()
    })

    it('重新登录 is one button above the grid, outside every card', async () => {
      setup([
        { id: 'a1', presetId: 'chatgpt', label: 'g1', state: 'needs_login' },
        { id: 'a2', presetId: 'chatgpt', label: 'g2', state: 'needs_login' },
      ], () => null)
      f.mffai.chatgpt.begin.mockResolvedValue({ flowId: 'f1' } as never)
      render(<ConnectionsPage />)
      await screen.findByText('g2')
      const btns = screen.getAllByRole('button', { name: '重新登录' })
      expect(btns).toHaveLength(1)
      expect(btns[0].closest('.mffai-acard')).toBeNull()
      const grid = document.querySelector('.mffai-agrid')!
      expect(btns[0].compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      fireEvent.click(btns[0])
      await waitFor(() => expect(f.mffai.chatgpt.begin).toHaveBeenCalledTimes(1))
    })
  })
})
