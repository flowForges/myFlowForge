/**
 * CLI 的插件 / 技能市场(claude plugin · codex plugin)在三端之间传的形状。
 * ★和这个 app **自己**的「插件」(设置里的 PluginPane、定时任务那套)是两回事,
 *  所以类型名和 channel 都带 `cli` 前缀,别混。
 */
export interface CliPlugin {
  /** `<name>@<marketplace>`,安装 / 卸载都用它。 */
  id: string
  name: string
  /** codex 的可安装列表里**没有说明** —— 缺就是空串,界面少画一行,不要编。 */
  description: string
  marketplace: string
  version: string
  installed: boolean
  /** 安装量(claude 有,codex 没有)。有就用来排序,没有就按名字排。 */
  installs?: number
  enabled?: boolean
}

export interface PluginCaps {
  plugin: boolean
  list: boolean
  json: boolean
  available: boolean
  /** 装的动词:claude 是 `install`,codex 是 `add`。★**探出来的**,不是写死的。 */
  installVerb: string | null
  /** 卸的动词:claude 是 `uninstall`,codex 是 `remove`。 */
  removeVerb: string | null
  marketplace: boolean
}

export const NO_PLUGIN_CAPS: PluginCaps = {
  plugin: false, list: false, json: false, available: false,
  installVerb: null, removeVerb: null, marketplace: false,
}

export interface CliPluginView {
  providerId: string
  displayName: string
  caps: PluginCaps
  plugins: CliPlugin[]
  error: string | null
}
