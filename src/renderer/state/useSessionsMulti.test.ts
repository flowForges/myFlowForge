import { it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSessionsMulti } from './useSessionsMulti'

beforeEach(() => {
  ;(globalThis as any).window = (globalThis as any).window ?? {}
  ;(window as any).forge = {
    sessionList: vi.fn(async (p: string) => ({ sessions: [{ id: p + '-s1', title: 'a', mode: 'chat', createdAt: 0 }], activeSessionId: p + '-s1' })),
    onSessionsChanged: vi.fn(() => () => {}),
  }
})

it('loads sessions for each path', async () => {
  const { result } = renderHook(() => useSessionsMulti(['/w1', '/w2']))
  await waitFor(() => {
    expect(result.current['/w1']?.[0]?.id).toBe('/w1-s1')
    expect(result.current['/w2']?.[0]?.id).toBe('/w2-s1')
  })
})

/**
 * ★★切主机之后,侧栏里那些展开着的工作区必须重新拉会话。
 *
 * 这个 hook 用一个 `loaded` ref 按 **workspacePath** 记「拉过了」,而两台机器上的工作区路径
 * 完全可以一模一样(同一个人、同样的目录习惯;自测时更是同一台机器上的同一个路径)。
 * ⇒ 切过去之后 `loaded.has(path)` 为真,**一次都不再拉**,屏幕上是上一台机器的会话列表,
 * 而侧栏那枚主机徽章已经写着新主机的名字。和 `useHome` 那条(2026-09-09 修的)是**同一个形状**:
 * 主进程 `remote/router.ts` 守着「绝不回落到本机」,渲染层的缓存从另一头把它破了。
 */
it('★★切主机之后重新拉 —— 路径一样也不许沿用上一台的缓存', async () => {
  const list = (window as any).forge.sessionList as ReturnType<typeof vi.fn>
  const { result, rerender } = renderHook(({ host }) => useSessionsMulti(['/w1'], host), {
    initialProps: { host: 'local' },
  })
  await waitFor(() => expect(result.current['/w1']?.[0]?.id).toBe('/w1-s1'))
  expect(list).toHaveBeenCalledTimes(1)

  list.mockImplementation(async (p: string) => ({
    sessions: [{ id: p + '-remote', title: '那台上的', mode: 'chat', createdAt: 0 }], activeSessionId: '',
  }))
  rerender({ host: 'h1' })

  await waitFor(() => expect(result.current['/w1']?.[0]?.id).toBe('/w1-remote'))
  expect(list).toHaveBeenCalledTimes(2)
})

it('★换主机那一刻先清空 —— 空着比显示上一台的对', async () => {
  const { result, rerender } = renderHook(({ host }) => useSessionsMulti(['/w1'], host), {
    initialProps: { host: 'local' },
  })
  await waitFor(() => expect(result.current['/w1']).toBeTruthy())
  ;(window as any).forge.sessionList = vi.fn(() => new Promise(() => {})) // 永不 resolve
  rerender({ host: 'h1' })
  expect(result.current['/w1'], '还没拉到就该是空的,不是上一台那份').toBeUndefined()
})

it('同一台主机内重复渲染不会重复拉(原来的懒加载还在)', async () => {
  const list = (window as any).forge.sessionList as ReturnType<typeof vi.fn>
  const { result, rerender } = renderHook(({ paths }) => useSessionsMulti(paths, 'local'), {
    initialProps: { paths: ['/w1'] },
  })
  await waitFor(() => expect(result.current['/w1']).toBeTruthy())
  rerender({ paths: ['/w1'] })
  rerender({ paths: ['/w1'] })
  expect(list).toHaveBeenCalledTimes(1)
})
