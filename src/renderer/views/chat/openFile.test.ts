import { describe, it, expect, vi } from 'vitest'
import { makeOpenFileApi } from './openFile'
import type { ResolvedRefResult } from './openFile'

const hit = (file: string, cwd = '/w'): ResolvedRefResult => ({ ok: true, cwd, file, abs: `${cwd}/${file}` })

describe('makeOpenFileApi 分流', () => {
  it('markdown / 代码 / 图片 → 开进全屏查看器(带解析出来的 cwd)', async () => {
    const openInViewer = vi.fn()
    const api = makeOpenFileApi(['/w'], {
      resolveFileRef: async () => hit('docs/design.md'),
      openFilePath: vi.fn(),
      openInViewer,
    })
    expect(await api.open('docs/design.md')).toBe('ok')
    expect(openInViewer).toHaveBeenCalledWith('docs/design.md', '/w')
  })

  it('.html 也进查看器(看源码),不直接丢给浏览器', async () => {
    const openInViewer = vi.fn()
    const openFilePath = vi.fn(async () => ({ ok: true }))
    const api = makeOpenFileApi(['/w'], { resolveFileRef: async () => hit('out/index.html'), openFilePath, openInViewer })
    expect(await api.open('out/index.html')).toBe('ok')
    expect(openInViewer).toHaveBeenCalled()
    expect(openFilePath).not.toHaveBeenCalled()
  })

  it('pdf/xlsx 这类 → 系统默认程序,不进查看器', async () => {
    const openInViewer = vi.fn()
    const openFilePath = vi.fn(async () => ({ ok: true }))
    const api = makeOpenFileApi(['/w'], { resolveFileRef: async () => hit('报告.pdf'), openFilePath, openInViewer })
    expect(await api.open('报告.pdf')).toBe('ok')
    expect(openFilePath).toHaveBeenCalledWith(['/w'], '报告.pdf')
    expect(openInViewer).not.toHaveBeenCalled()
  })

  it('系统打开失败 → error', async () => {
    const api = makeOpenFileApi(['/w'], {
      resolveFileRef: async () => hit('a.zip'),
      openFilePath: async () => ({ ok: false, error: 'boom' }),
      openInViewer: vi.fn(),
    })
    expect(await api.open('a.zip')).toBe('error')
  })

  it('解析失败原样把原因传上去(链接旁的提示靠它区分文案)', async () => {
    const mk = (reason: 'missing' | 'outside' | 'dir' | 'bad') =>
      makeOpenFileApi(['/w'], { resolveFileRef: async () => ({ ok: false, reason }), openFilePath: vi.fn(), openInViewer: vi.fn() })
    expect(await mk('missing').open('x')).toBe('missing')
    expect(await mk('outside').open('x')).toBe('outside')
    expect(await mk('dir').open('x')).toBe('dir')
    expect(await mk('bad').open('x')).toBe('bad')
  })

  it('老版本 preload 没有这个 IPC 时不炸(返回 error)', async () => {
    const api = makeOpenFileApi(['/w'], { openInViewer: vi.fn() })
    expect(await api.open('docs/a.md')).toBe('error')
  })
})
