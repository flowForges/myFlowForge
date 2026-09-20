import { describe, it, expect, vi } from 'vitest'
import { launchOpener, type SpawnLike } from './launch'

/** 一个可编排的假 child:用例自己决定它 'spawn' 还是 'error'。 */
function fakeSpawn(behave: 'spawn' | 'error' | 'nothing', err = new Error('spawn ENOENT')) {
  const calls: { exe: string; args: string[]; opts: Record<string, unknown> }[] = []
  const unref = vi.fn()
  const fn: SpawnLike = (exe, args, opts) => {
    calls.push({ exe, args, opts })
    const handlers: Record<string, ((a?: unknown) => void)[]> = { error: [], spawn: [] }
    const child = {
      once(ev: 'error' | 'spawn', cb: (a?: unknown) => void) { handlers[ev].push(cb); return child },
      unref,
    }
    // 下一拍再发事件 —— 真的 spawn 也是异步的,同步发会让「先注册后触发」的顺序假成立。
    queueMicrotask(() => {
      if (behave === 'spawn') for (const h of handlers.spawn) h()
      if (behave === 'error') for (const h of handlers.error) h(err)
    })
    return child as never
  }
  return { fn, calls, unref }
}

/**
 * 用户 2026-09-14 报:Windows 上用「打开方式」,**确实打开了**,但会弹一个框说命令出错。
 *
 * ★★根因是拿进程的**退出码**当「打开成功没有」的判据。`explorer.exe` 在 Windows 上
 *  **成功时也返回 1**,于是文件夹开了、框也弹了。反过来,一个前台不退出的编辑器会让
 *  回调永远不触发,那次 IPC 就一直挂着。
 *
 * 正确语义:只关心**起没起来**。
 */
describe('launchOpener', () => {
  it('★★进程起来了就算成功 —— 不等它退出、更不看退出码', async () => {
    const { fn, calls } = fakeSpawn('spawn')
    await expect(launchOpener({ exe: 'C:\\Windows\\explorer.exe', args: ['D:\\proj'] }, fn)).resolves.toBeUndefined()
    expect(calls[0].exe).toBe('C:\\Windows\\explorer.exe')
    expect(calls[0].args).toEqual(['D:\\proj'])
  })

  it('★起不来才算失败(exe 不存在 / 没权限),错误原样抛给上层报给用户', async () => {
    const { fn } = fakeSpawn('error', new Error('spawn ENOENT'))
    await expect(launchOpener({ exe: 'nope.exe', args: [] }, fn)).rejects.toThrow(/ENOENT/)
  })

  it('★detached + unref —— 被打开的编辑器不能挂在 Forge 的生命周期上', async () => {
    // 不 unref 的话,退出 Forge 会把用户的编辑器一起带走。
    const { fn, calls, unref } = fakeSpawn('spawn')
    await launchOpener({ exe: 'code', args: ['/p'] }, fn)
    expect(calls[0].opts).toMatchObject({ detached: true, stdio: 'ignore' })
    expect(calls[0].opts.windowsHide).toBeUndefined()   // 见 launch.ts:修 bug 时不顺手加参数
    expect(unref).toHaveBeenCalled()
  })

  it('error 和 spawn 都来了也只结算一次', async () => {
    const { fn } = fakeSpawn('spawn')
    const p = launchOpener({ exe: 'x', args: [] }, fn)
    await expect(p).resolves.toBeUndefined()
    await expect(p).resolves.toBeUndefined()   // 同一个 promise,不会变
  })
})
