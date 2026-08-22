import type { HostCapabilities } from './capabilities'

/**
 * 测试用的宿主:默认全部答「什么也没发生」——选择器返回空(等同用户取消)、打开成功、图标拿不到。
 * 要断言某个交互的用例自己覆盖需要的那一两个方法:`fakeHost({ pickPaths: async () => ['/x'] })`。
 *
 * 放在 `.test.ts` 之外是有意的:好几个测试文件都要用它,`.test.ts` 之间不能互相 import。
 */
export function fakeHost(over: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    version: () => '0.0.0-test',
    tempDir: () => '/tmp',
    appPath: () => '/app',
    isPackaged: () => false,
    openExternal: async () => {},
    openPath: async () => '',
    revealInFileManager: () => {},
    pickPaths: async () => [],
    saveFile: async () => ({ ok: false, canceled: true }),
    notify: () => {},
    fileIcon: async () => undefined,
    ...over,
  }
}
