import { tmpdir } from 'node:os'
import type { HostCapabilities } from './capabilities'

/**
 * 无头宿主(Linux daemon)的宿主能力实现。
 *
 * 那台机器上没人看着屏幕:弹不了对话框、开不了浏览器、发不了系统通知。
 * 第二期 D 会把这几件事**转发给连上来的客户端**(「你那边帮我打开一下」),
 * 本阶段先老实地答「做不了」,并且**答得可预期**:
 *
 * - `pickPaths` 返回 `[]` —— 与「用户取消」同形。调用方本来就都能处理取消,
 *   所以不会炸;而这三个选择器根本不会被 daemon 对外提供(见 DAEMON_UNSUPPORTED),
 *   客户端那边直接是置灰的。
 * - `openPath` 返回一句错误(沿用 shell.openPath「失败返回字符串」的契约),
 *   界面会照常显示「打开失败:…」,而不是「点了没反应」。
 */
export function createHeadlessHost(opts: { version: string; onLog?: (m: string) => void }): HostCapabilities {
  const log = opts.onLog ?? (() => {})
  const cannot = (what: string) => {
    log(`无头模式下做不了:${what}`)
    return `这台主机没有桌面环境,${what}需要在客户端那台机器上进行`
  }
  return {
    version: () => opts.version,
    tempDir: () => tmpdir(),
    appPath: () => undefined,
    isPackaged: () => false,
    openExternal: async (url) => { cannot(`打开链接 ${url}`) },
    openPath: async (p) => cannot(`打开 ${p}`),
    revealInFileManager: (p) => { cannot(`在文件管理器中显示 ${p}`) },
    pickPaths: async () => { cannot('选择文件/目录'); return [] },
    saveFile: async (name) => ({ ok: false, error: cannot(`保存 ${name}`) }),
    notify: (n) => log(`[通知] ${n.title} — ${n.body}`),
    fileIcon: async () => undefined,
  }
}
