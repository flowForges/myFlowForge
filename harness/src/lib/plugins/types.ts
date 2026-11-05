// 插件格式读取的数据形状(09 spec §5、§7.1)。纯数据,不带行为
import type { Flag } from '../memory/scan'

export type Warning =
  | 'no_manifest'
  | 'unpinned_source'
  | 'source_changed'
  | 'runtime_fetch'
  | 'shell_in_text'
  | 'hidden_chars'
  | 'submodules_skipped'
  | 'hooks_not_run'
  | 'truncated'
  // 以下三个是读取时加的:路径或名字不合规被丢弃、文件读不了
  | 'path_dropped'
  | 'name_dropped'
  | 'file_unreadable'
  // 安装时加的:来源里有 .ssh 这类目录
  | 'credentials_in_source'

export type ServerProblem = 'arg_env_ref' | 'dangerous_env' | 'runtime_unsupported' | 'bad_command' | 'command_outside_root' | 'name_invalid'

export type Cwd = 'none' | 'read' | 'write'

export interface ConfigKey {
  key: string
  title: string
  sensitive: boolean
  required: boolean
  type: string
  /** manifest:清单的 userConfig;mcp:只是服务配置里引用了 `${VAR}`,一律敏感 */
  from: 'manifest' | 'mcp'
}

export interface EnvEntry {
  name: string
  source: 'literal' | 'config' | 'secret'
  required: boolean
  /** 只有 literal,原文。打码是同意页的事 */
  value?: string
}

export interface ParsedServer {
  name: string
  command: string
  /** 符号形式:${PLUGIN_ROOT}、${PLUGIN_DATA}、${PROJECT_DIR} 不展开 */
  args: string[]
  env: EnvEntry[]
  fetchesAtRuntime: boolean
  declared: { network: string[]; cwd: Cwd } | null
  suggestedHosts: string[]
  problems: ServerProblem[]
  /** 这个服务引用的配置键:`${user_config.K}` 的 K 和裸 `${VAR}` 的 VAR */
  configRefs: string[]
  /** 不是 stdio:不进 servers,进 notRun.remoteMcp */
  remote?: { type: string; url: string }
}

export interface ParsedSkill {
  name: string
  /** 技能目录,相对根;根上的 SKILL.md 是 '' */
  dir: string
  /** SKILL.md 相对根的路径 */
  file: string
  description: string
  modelInvocable: boolean
  userInvocable: boolean
  argumentHint?: string
  argNames: string[]
  files: number
  flags: Flag[]
  ignored: string[]
  hiddenChars: boolean
  /** 超过 256 KB:read 回 too_large */
  tooLarge: boolean
  bodyHash: string
}

export interface ParsedCommand {
  name: string
  /** 文件相对根的路径;内联 content 没有 */
  file?: string
  description: string
  argumentHint?: string
  argNames: string[]
  flags: Flag[]
  ignored: string[]
  hiddenChars: boolean
  /** 超过 64 KB:body 为空,run 回 too_large */
  tooLarge: boolean
  /** 去掉 frontmatter 的正文 */
  body: string
  bodyHash: string
}

export interface NotRun {
  hooks: { event: string; command: string }[]
  agents: string[]
  bin: string[]
  monitors: string[]
  workflows: string[]
  lsp: string[]
  /** outputStyles、themes、settings、dependencies、channels */
  other: string[]
  remoteMcp: { name: string; type: string; url: string }[]
  main?: string
  scripts: string[]
}

export interface Claimed {
  name: string
  description: string
  author?: string
  homepage?: string
}

export interface ParsedPlugin {
  id: string
  version: string
  format: 'native' | 'claude'
  claimed: Claimed
  skills: ParsedSkill[]
  commands: ParsedCommand[]
  servers: ParsedServer[]
  config: ConfigKey[]
  notRun: NotRun
  warnings: Warning[]
}

export type ReadError = 'not_a_plugin' | 'id_reserved' | 'bad_manifest' | 'kernel_incompatible'

export const SKILL_MAX = 256 * 1024
export const COMMAND_MAX = 64 * 1024

/** 属性和索引里的名字:不合规的不进去 */
export const NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,64}$/
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
/** 这几个名字落在普通对象上会碰到原型;查表一律用 Map,名字也不收 */
export const PROTO_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** 按字符数截断,不劈开代理对。只切片,不展开成数组:超长输入也是常数内存 */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const c = max > 0 ? s.charCodeAt(max - 1) : 0
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max)
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
