import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UpgradeModal } from './UpgradeModal'

const INFO = { version: '2.4.0', notes: '工作流混合编排\n文件树提速', assetUrl: 'u', assetSize: 26214400, assetName: 'a.dmg' }
const base = { open: true, onClose: () => {}, info: INFO, currentVersion: '1.0.0', progress: null as any, onStart: () => {} }

describe('UpgradeModal', () => {
  it('shows current → latest version in the hero', () => {
    render(<UpgradeModal {...base} phase="available" />)
    expect(screen.getByText(/v1\.0\.0/)).toBeTruthy()
    expect(screen.getByText('v2.4.0')).toBeTruthy()
  })
  it('renders release notes as markdown (table, bold, list) instead of raw text', () => {
    const notes = '| 平台 | 文件 |\n|---|---|\n| macOS | `a.dmg` |\n\n- **修复 iOS 闪退**\n- 中转地址可保存多个'
    const { container } = render(<UpgradeModal {...base} info={{ ...INFO, notes }} phase="available" />)
    expect(container.querySelector('.upd-notes table')).toBeTruthy()
    expect(container.querySelector('.upd-notes strong')?.textContent).toBe('修复 iOS 闪退')
    expect(container.querySelectorAll('.upd-notes li').length).toBe(2)
    expect(container.querySelector('.upd-notes')?.textContent).not.toContain('|')
    expect(container.querySelector('.upd-notes')?.textContent).not.toContain('**')
  })
  it('calls onStart when 立即升级 is clicked', () => {
    const onStart = vi.fn()
    render(<UpgradeModal {...base} phase="available" onStart={onStart} />)
    fireEvent.click(screen.getByText('立即升级'))
    expect(onStart).toHaveBeenCalled()
  })
  it('reflects download progress', () => {
    const { container } = render(<UpgradeModal {...base} phase="downloading" progress={{ stage: '正在下载更新包…', pct: 42 }} />)
    expect(screen.getByText('正在下载更新包…')).toBeTruthy()
    expect(screen.getByText('42%')).toBeTruthy()
    expect((container.querySelector('.upd-bar i') as HTMLElement).style.width).toBe('42%')
  })
  it('shows the honest option-1 done copy (drag to Applications, no auto-restart)', () => {
    render(<UpgradeModal {...base} phase="done" />)
    expect(screen.getByText(/应用程序/)).toBeTruthy()
    expect(screen.queryByText(/下次启动/)).toBeNull()
  })
  it('on error, shows a clickable GitHub releases link that opens externally', () => {
    const openExternal = vi.fn(async () => ({ ok: true }))
    ;(window as any).forge = { openExternal }
    render(<UpgradeModal {...base} phase="error" />)
    const link = screen.getByText(/github\.com\/flowForges\/myFlowForge\/releases/)
    expect(link).toBeTruthy()
    fireEvent.click(link)
    expect(openExternal).toHaveBeenCalledWith('https://github.com/flowForges/myFlowForge/releases/latest')
  })
})
