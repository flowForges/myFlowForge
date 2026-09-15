import { spawn } from 'node:child_process'
import type { LaunchCommand } from './buildOpenCommand'

/** 起一个进程。抽成参数是为了让 launch.test.ts 能在不真的开程序的情况下测两条分支。 */
export type SpawnLike = (exe: string, args: string[], opts: Record<string, unknown>) => {
  once(ev: 'error', cb: (e: Error) => void): unknown
  once(ev: 'spawn', cb: () => void): unknown
  unref?(): unknown
}

/**
 * 用某个软件打开一个路径。**fire-and-forget**:起得来就算成功。
 *
 * ★★★这里绝不能拿进程的**退出码**当成败判据 —— 它说明不了「打开成功没有」。原来用
 *  `execFile(exe, args, cb)`,cb 在进程退出时才带着退出码回来,两头都错:
 *
 *  · Windows 的 `explorer.exe` **成功时也返回 1**。于是文件夹明明打开了,却弹一个
 *    「命令出错」的框 —— 用户 2026-09-14 报的就是这个:「确实打开了,但是会出现一个弹窗,
 *    说一个命令出错还是不存在」。
 *  · 反过来,一个前台不退出的编辑器(冷启动的 VS Code / Sublime)会让 cb **一直不触发**,
 *    这次 IPC 就永远挂着,直到用户把编辑器关掉为止。
 *
 *  正确的语义:我们只关心**能不能起来**。Node 的 `'spawn'` 事件正是「进程已成功创建」,
 *  而真正的失败(exe 不存在 / 没权限)走 `'error'` —— 那个才该报给用户看。
 *
 * ★`detached: true` + `unref()`:被打开的编辑器不该挂在 Forge 的生命周期上,
 *  否则退出 Forge 会把人家一起带走。
 */
export function launchOpener(cmd: LaunchCommand, spawnFn: SpawnLike = spawn as unknown as SpawnLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    // ★不加 `windowsHide`:原来的 execFile 也没有它,而这次只该修「用退出码判成败」这一件事。
    //  它的作用是压掉控制台窗口,对 GUI 程序毫无收益,却多一个在 Windows 上和 detached 互相作用的
    //  未知数 —— 修 bug 时顺手加参数,是把一个已知问题换成一个未知问题。
    const child = spawnFn(cmd.exe, cmd.args, { detached: true, stdio: 'ignore' })
    child.once('error', (e: Error) => {
      if (settled) return
      settled = true
      reject(e)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      try { child.unref?.() } catch { /* 假 child 可能没有 unref */ }
      resolve()
    })
  })
}
