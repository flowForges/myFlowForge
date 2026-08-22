export type PickOptions = {
  kind: 'file' | 'directory'
  multi?: boolean
  title?: string
  /** 目录模式下允许用户在选择器里现场新建目录(新建工作区那两处要) */
  createDirectory?: boolean
  /** 文件模式下的类型过滤(选宠物图 / 背景图那两处要) */
  filters?: { name: string; extensions: string[] }[]
}

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; canceled?: true; error?: string }

/**
 * 核心逻辑用得到、但只有「宿主」才答得上来的能力。
 *
 * 前四个宿主自己就能答;中间五个是「在有人的那台机器上做点什么」;最后两个是桌面外壳专属,
 * 无头宿主给不了(返回 undefined)。
 *
 * Electron 宿主(mac/Windows)给真实现;Linux daemon 除 version/tempDir 外**转发给连上来的
 * 客户端**,pickPaths 走服务端目录选择器。
 */
export interface HostCapabilities {
  /** app 版本号,更新检查用 */
  version(): string
  /** 下载/导出的落脚点 */
  tempDir(): string
  /** app 自身的安装路径(取自身图标用)。无头宿主返回 undefined */
  appPath(): string | undefined
  /** 是否打包运行(决定去哪儿找随包资源) */
  isPackaged(): boolean

  /** 用系统浏览器打开链接。永远在**客户端**执行 —— daemon 那台没人看着屏幕 */
  openExternal(url: string): Promise<void>
  /**
   * 用默认程序打开一个路径。
   * ★契约照抄 `shell.openPath`:**成功返回空串,失败返回错误描述,不抛。**
   * 包装成 throw 或吞掉都会让「打开失败」在界面上表现为「点了没反应」。
   */
  openPath(path: string): Promise<string>
  /** 在 Finder / 资源管理器里定位到它 */
  revealInFileManager(path: string): void
  /** 弹选择器。★**用户取消时返回 `[]`,不是 undefined** —— 调用方全都在取 `[0]` */
  pickPaths(opts: PickOptions): Promise<string[]>
  /**
   * 导出:内容由核心产出,落盘归客户端。
   * 返回里带 path 是有意的 —— 界面要显示「已导出到 …」;远程时那是**客户端上的**路径,依然有意义。
   */
  saveFile(defaultName: string, data: string | Uint8Array, title?: string): Promise<SaveResult>
  /** 系统通知 */
  notify(n: { title: string; body: string; onClick?: () => void }): void

  /** 提取某个可执行文件的图标,data URL。无头宿主返回 undefined */
  fileIcon(path: string): Promise<string | undefined>
}
