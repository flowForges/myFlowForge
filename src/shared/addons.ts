/**
 * 「加载项」在主进程 / 渲染层 / 手机端之间传的形状。
 * 三端都要用,所以放 shared —— 抄三份的结局是某一端静默显示成空白。
 */
export type AddonKind = 'skill' | 'rule' | 'mcp'

export interface Addon {
  /** 稳定键。**删除只认它**,路径由主机侧的扫描结果给(见 main/agents/addons.ts 的注释)。 */
  id: string
  kind: AddonKind
  /** provider id(claude / codex / …),界面按它分组和筛选。 */
  provider: string
  name: string
  description?: string
  /**
   * 技能包名(`~/.claude/skills/<包>/skills/<技能>` 这种布局里的 `<包>`)。
   * ★为什么要它:这台机器上实测扫出 **178 个技能**,绝大多数来自几个包 —— 不标包名的话,
   *  那就是一屏看不完的陌生名字,人根本认不出「这些是我装的那个包带来的」。
   */
  pack?: string
  /** skill = SKILL.md 所在目录;rule = 那个文件;mcp = 它所在的配置文件。 */
  path: string
  /** 这个 provider 现在探测得到吗。false = 卸载了但东西还在磁盘上。 */
  installed: boolean
  removable: boolean
  /** 'trash' = 删文件/目录(能走废纸篓就走);'cli' = 调 CLI 自己的 `mcp remove`。 */
  removeVia: 'trash' | 'cli' | null
  /** 不能删的原因,或者删之前该知道的事。 */
  note?: string
}

export interface AddonScan {
  addons: Addon[]
  /** 主机的 home,删除时的安全闸门用它(只允许删 home 底下的东西)。 */
  home: string
}

export const ADDON_KIND_LABEL: Record<AddonKind, string> = { skill: 'Skill', rule: 'Rule', mcp: 'MCP' }
