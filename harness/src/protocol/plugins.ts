// 09:插件(spec §5、§7、§8)。同意页的形状是 lib/plugins 和 08 共用的,所以在协议里
import { z } from 'zod'

/** 插件 id:只有这个形状进得了路径和 secret 键的前缀 */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
export const PluginIdSchema = z.string().regex(PLUGIN_ID)

export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/
export const McpServerNameSchema = z.string().regex(MCP_SERVER_NAME)

/** 配置键:userConfig 的键或 `${VAR}` 的名字。secret 键是 <插件 id>/<key>,不能带 `/` */
export const PluginSettingKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

export const PluginFormatSchema = z.enum(['native', 'claude'])
export type PluginFormat = z.infer<typeof PluginFormatSchema>

/** plugins.mcp.status、plugins.get、plugins.mcp.status RPC 的 state。refused:没起就拒了,reason 说为什么 */
export const McpStateSchema = z.enum(['starting', 'running', 'stopping', 'stopped', 'refused', 'problem', 'server_failed', 'needs_sandbox', 'needs_config', 'integrity_failed', 'disabled'])
export type McpState = z.infer<typeof McpStateSchema>

/** 稳定代码。08 按它们分支:没有路径、没有第三方的文字 */
export const McpReasonSchema = z.enum([
  // 清单里的问题(从不启动)
  'arg_env_ref', 'dangerous_env', 'runtime_unsupported', 'bad_command', 'command_outside_root', 'name_invalid',
  // 起之前的拒绝
  'runtime_too_broad', 'keep_too_broad', 'cwd_too_broad', 'consent_mismatch', 'sandbox_unavailable', 'secrets_unavailable',
  'integrity_failed', 'data_dir_unsafe', 'needs_config', 'needs_sandbox', 'grants_invalid', 'grants_changed', 'plugin_unreadable',
  'plugin_disabled', 'plugin_not_installed', 'server_not_found', 'server_problem', 'no_session', 'too_many_servers', 'spawn_failed',
  'program_not_found', 'server_failed', 'server_not_running', 'server_stopped',
  // 起来之后
  'init_timeout', 'call_timeout', 'protocol_error', 'server_exited', 'cancelled', 'too_many_tools', 'tools_changed',
])
export type McpReason = z.infer<typeof McpReasonSchema>

export const McpCwdSchema = z.enum(['none', 'read', 'write'])
export type McpCwd = z.infer<typeof McpCwdSchema>

/** 只从 RPC 来,逐服务。闭合结构:写不出路径 */
export const GrantsSchema = z.strictObject({
  servers: z.record(McpServerNameSchema, z.strictObject({ network: z.array(z.string().max(253)).max(64), cwd: McpCwdSchema })),
})
export type Grants = z.infer<typeof GrantsSchema>

/** 安装来源。ref、url 的形状由拉取前的检查定,错误码是它的 */
export const PluginSourceParamSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('git'), url: z.string().min(1).max(2048), ref: z.string().max(256).optional(), subpath: z.string().max(4096).optional() }),
])
export type PluginSourceParam = z.infer<typeof PluginSourceParamSchema>

export const PluginSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string() }),
  z.object({ kind: z.literal('git'), url: z.string(), ref: z.string().optional(), commit: z.string(), subpath: z.string().optional() }),
])
export type PluginSource = z.infer<typeof PluginSourceSchema>

export const PluginWarningSchema = z.enum(['no_manifest', 'unpinned_source', 'source_changed', 'runtime_fetch', 'shell_in_text', 'hidden_chars', 'submodules_skipped', 'hooks_not_run', 'truncated', 'path_dropped', 'name_dropped', 'file_unreadable', 'credentials_in_source'])
export type PluginWarning = z.infer<typeof PluginWarningSchema>

const HookEntrySchema = z.object({ event: z.string(), command: z.string(), /** 命令里有打码的内容:显示的和运行的不一样 */ masked: z.boolean().optional() })
const Names = z.array(z.string())

export const PluginDiffSchema = z.object({
  fromVersion: z.string(),
  toVersion: z.string(),
  sourceChanged: z.boolean(),
  mcp: z.object({ added: Names, removed: Names, changed: z.array(z.object({ name: z.string(), fields: z.array(z.enum(['command', 'args', 'env', 'declared'])) })) }),
  skills: z.object({ added: Names, removed: Names, textChanged: Names }),
  commands: z.object({ added: Names, removed: Names, textChanged: Names }),
  network: z.object({ added: Names, removed: Names }),
  /** 新增的配置键;必填且敏感的单列 */
  config: z.object({ added: Names, requiredSensitive: Names }),
  /** added:新出现的不执行项,`<类别>:<名字>` */
  notRun: z.object({ hooksAdded: z.array(HookEntrySchema), hooksRemoved: z.array(HookEntrySchema), added: Names }),
  /** 只有一个文件数:同意页没有文件清单,逐文件的增删改说不准。内容变没变看 integrity */
  files: z.object({ from: z.number(), to: z.number() }),
  /** 完整性变了就给两头;一样是 null。只改代码的升级靠它显示 */
  integrity: z.object({ from: z.string(), to: z.string() }).nullable(),
})
export type PluginDiff = z.infer<typeof PluginDiffSchema>

export const PluginConsentSchema = z.object({
  id: z.string(),
  version: z.string(),
  format: PluginFormatSchema,
  /** 插件自称的,清理、截断后给;08 要标明是自称 */
  claimed: z.object({ name: z.string(), description: z.string(), author: z.string().optional(), homepage: z.string().optional() }),
  source: PluginSourceSchema,
  integrity: z.string(),
  files: z.number(),
  bytes: z.number(),
  skills: z.array(z.object({ name: z.string(), description: z.string(), modelInvocable: z.boolean(), userInvocable: z.boolean(), files: z.number(), flags: Names, ignored: Names })),
  commands: z.array(z.object({ name: z.string(), description: z.string(), flags: Names, ignored: Names })),
  mcp: z.array(z.object({
    name: z.string(),
    command: z.string(),
    /** 符号形式:${PLUGIN_ROOT}、${PLUGIN_DATA}、${PROJECT_DIR} 不展开(M12) */
    args: Names,
    /** args 里被打码的下标:显示的和运行的不一样 */
    argsMasked: z.array(z.number()),
    /** npx、uvx、bunx:运行时才下代码,钉不住 */
    fetchesAtRuntime: z.boolean(),
    /** value 只有 literal 有,打码后 */
    env: z.array(z.object({ name: z.string(), source: z.enum(['literal', 'config', 'secret']), required: z.boolean(), value: z.string().optional() })),
    /** Claude Code 格式是 null */
    declared: z.object({ network: Names, cwd: McpCwdSchema }).nullable(),
    /** 只是建议,默认不勾 */
    suggestedHosts: Names,
    problems: Names,
  })),
  config: z.array(z.object({ key: z.string(), title: z.string(), sensitive: z.boolean(), required: z.boolean(), type: z.string() })),
  notRun: z.object({
    hooks: z.array(HookEntrySchema),
    agents: Names,
    bin: Names,
    monitors: Names,
    workflows: Names,
    lsp: Names,
    other: Names,
    remoteMcp: z.array(z.object({ name: z.string(), type: z.string(), url: z.string() })),
    main: z.string().optional(),
    scripts: Names,
  }),
  warnings: z.array(PluginWarningSchema),
  /** 同意页上被截或被剪的描述性部分,和少列了多少。有执行效果的内容永不进这里:放不下就整个拒绝 */
  truncatedSections: z.array(z.object({ section: z.string(), omitted: z.number() })),
  diff: PluginDiffSchema.optional(),
})
/** buildConsent 的拒绝:有执行效果的部分超过预算,不给残缺的同意页 */
export const PluginConsentErrorSchema = z.enum(['consent_too_large'])
export type PluginConsentError = z.infer<typeof PluginConsentErrorSchema>
export type PluginConsent = z.infer<typeof PluginConsentSchema>

export const PluginInstallStateSchema = z.enum(['fetching', 'ready', 'failed'])
export type PluginInstallState = z.infer<typeof PluginInstallStateSchema>
