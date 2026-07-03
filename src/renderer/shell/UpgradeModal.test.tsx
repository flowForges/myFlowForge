import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UpgradeModal } from './UpgradeModal'

const INFO = { version: '2.4.0', notes: '工作流混合编排\n文件树提速', dmgUrl: 'u', dmgSize: 26214400, dmgName: 'a.dmg' }
const base = { open: true, onClose: () => {}, info: INFO, currentVersion: '1.0.0', progress: null as any, onStart: () => {} }

describe('UpgradeModal', () => {
  it('shows current → latest version in the hero', () => {
    render(<UpgradeModal {...base} phase="available" />)
    expect(screen.getByText(/v1\.0\.0/)).toBeTruthy()
    expect(screen.getByText('v2.4.0')).toBeTruthy()
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
})
