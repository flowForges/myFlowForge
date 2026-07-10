import { z } from 'zod'
import type { Plugin as SharedPlugin, LibraryHook as SharedLibraryHook } from '../../shared/plugin'
import { PET_SCALE_MIN, PET_SCALE_MAX } from '../../shared/petGeometry'
import { DEFAULT_BUILTIN_PET_ID, builtinPets } from '../../shared/builtinPets'
import { PET_CUSTOM_MAX } from '../../shared/petCustom'

export const STAGE_KEYS = ['requirement', 'design', 'develop', 'test', 'review'] as const
export type StageKey = (typeof STAGE_KEYS)[number]

export const HOOK_SKILL_IDS = ['systematic-debugging','writing-plans','test-driven-development','code-review','ai-slop-cleaner','analyze'] as const
export const HOOK_TOOL_IDS = ['read','edit','bash','grep','git','web','mcp'] as const

export const PluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  after: z.string(),
  skills: z.array(z.string()).default(() => []),
  tools: z.array(z.string()).default(() => []),
})
export type Plugin = z.infer<typeof PluginSchema>

// A reusable, slot-agnostic hook stored in the global library (设置 → Hook 库). Same shape as Plugin
// MINUS `after` — the slot is assigned only when the hook is copied into a workspace at create time,
// so one library entry can be reused at any boundary/stage.
export const LibraryHookSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  skills: z.array(z.string()).default(() => []),
  tools: z.array(z.string()).default(() => []),
})
export type LibraryHook = z.infer<typeof LibraryHookSchema>
export const HookLibrarySchema = z.object({ hooks: z.array(LibraryHookSchema) })
export const defaultHookLibrary = () => ({ hooks: [] as LibraryHook[] })

// Compile-time guard: the zod-inferred Plugin (main) and the hand-written shared/plugin.ts interface
// (used by the renderer, which can't import this main-only module) must stay structurally identical.
// If either side drifts, one of these conditional types resolves to `never` and tsc fails here.
type _AssertExtends<A extends B, B> = true
type _PluginParity = _AssertExtends<Plugin, SharedPlugin> & _AssertExtends<SharedPlugin, Plugin>
type _LibraryHookParity = _AssertExtends<LibraryHook, SharedLibraryHook> & _AssertExtends<SharedLibraryHook, LibraryHook>
export const STAGE_NAMES: Record<StageKey, string> = {
  requirement: '需求评估', design: '技术方案设计', develop: '代码开发', test: '写单测', review: '代码 CR'
}

// 每个阶段的内置默认提示词正文(恒发给阶段子代理)。文案取自原型 STAGE_LIB,key 用代码现有。
// 用户只能在其后追加(WsStage.prompt / Workflow.stagePrompts),不能改这里。
export const STAGE_PROMPTS: Record<StageKey, string> = {
  requirement: '拆解本次需求,明确目标、范围边界与验收标准;识别关键风险与待澄清的问题,并把结论整理成要点交给后续阶段。',
  design: '基于需求产出技术方案:模块划分、接口/数据结构设计、关键技术决策与替代方案,并评估技术风险与影响面。',
  develop: '按技术方案实现代码变更,遵循项目既有规范与目录约定;保持改动聚焦、可回滚,并在必要处补充说明性注释。',
  test: '为本次改动补充单元 / 回归测试,覆盖核心路径与边界条件;确保测试可独立运行且能稳定复现回归。',
  review: '审查改动 diff:正确性、安全性、规范与可维护性;区分「必须修复」与「建议项」,并明确是否可以合并。',
}

// —— 自定义阶段支持(#3)——
// 阶段词汇表不再是闭合枚举:阶段 key 是任意字符串,name/prompt/行为开关挂在阶段对象上。上面三个
// 常量降级为「内置默认回退表」——内置 key 的 name/prompt/行为缺省时回退到它们,自定义 key 走对象自带数据。
export const BUILTIN_STAGE_KEYS: readonly string[] = STAGE_KEYS
export function isBuiltinStage(key: string): key is StageKey { return (BUILTIN_STAGE_KEYS as string[]).includes(key) }
// 显示名:阶段自带 name 优先,内置 key 回退 STAGE_NAMES,最后回退 key 本身。
export function stageName(key: string, name?: string): string {
  return (name && name.trim()) || (isBuiltinStage(key) ? STAGE_NAMES[key] : '') || key
}
// 基础提示词正文:内置 key 有恒定基座(STAGE_PROMPTS),此时阶段自带 prompt 是「追加段」;自定义 key
// 无基座,其 prompt 即完整正文。返回内置基座(若有),追加逻辑在 buildStagePrompt 里按此区分。
export function stageBasePrompt(key: string): string | undefined {
  return isBuiltinStage(key) ? STAGE_PROMPTS[key] : undefined
}
// 阶段行为默认(按内置 key)。自定义 key 落到最保守项。显式 flag 永远优先(在各消费点用 `spec.flag ?? 默认`)。
export const DEFAULT_STAGE_PER_PROJECT_AGENT: Record<string, boolean> = { develop: true }   // 用各项目自己的 provider/model
export const DEFAULT_STAGE_PRODUCES_DOC: Record<string, boolean> = { design: true }          // 强制写 markdown 方案文件
export const DEFAULT_STAGE_SUMMARY: Record<string, boolean> = { design: true }               // per-project 后追加汇总代理

export const AppearanceSchema = z.object({
  theme: z.enum(['dark', 'light', 'auto', 'midnight', 'sepia', 'forest']),
  accent: z.enum(['blue', 'violet', 'indigo', 'cyan', 'teal', 'emerald', 'lime', 'amber', 'orange', 'rose', 'magenta', 'graphite']).default('blue'),
  vibrancy: z.boolean(),
  glass: z.boolean().default(false),
  // Whole-window transparency via BrowserWindow.setOpacity — reliable + live (no restart), unlike the
  // shelved vibrancy/glass path. 1 = fully opaque; user-adjustable down to 0.3 via a slider.
  windowOpacity: z.number().min(0.3).max(1).default(1),
  // 磨砂度 (frosted-glass amount). 0 = off (flat opaque window). >0 enables the designed glass system:
  // the main window is (re)built transparent + macOS vibrancy so the real desktop shows through frosted
  // (native, GPU-cheap), and CSS panel blur scales with this value. The vibrancy material is set at
  // window CREATION (changing the level takes effect on relaunch — avoids the live-toggle render glitch
  // that shelved this path); the in-app panel blur updates live via a CSS var.
  blurAmount: z.number().min(0).max(1).default(0),
  density: z.enum(['comfortable', 'compact']),
  fontSize: z.enum(['small', 'medium', 'large']),
  // 背景图:用户上传的图片(存为 data URL,自包含无需管理文件)。bgScope 决定铺在整个应用还是仅会话区;
  // 'off' 或空图 = 关闭。bgOpacity 是图片层的可见度(其上有一层底色蒙版保证正文可读)。
  bgImage: z.string().default(''),
  bgScope: z.enum(['off', 'app', 'chat']).default('off'),
  bgOpacity: z.number().min(0.05).max(1).default(0.35),
  // 首页 (home) 背景图:独立于上面的应用/会话区背景,可同可不同。homeBgOn 是首页背景的独立开关,
  // homeBgImage 存图片 data URL,homeBgOpacity 是首页图片层的可见度。首页上此背景盖过 'app' 范围背景。
  homeBgImage: z.string().default(''),
  homeBgOn: z.boolean().default(false),
  homeBgOpacity: z.number().min(0.05).max(1).default(0.35)
})
export type Appearance = z.infer<typeof AppearanceSchema>
export const SkillsSchema = z.record(z.string(), z.boolean())
export const PET_STATES = ['idle', 'working', 'confirm', 'input', 'done'] as const
export type PetState = typeof PET_STATES[number]
export const AnimSchema = z.enum(['float', 'spin-halo', 'alert', 'tilt', 'pulse-ok', 'bounce', 'jelly', 'glow-breathe', 'sparkle', 'flip', 'none'])
export type Anim = z.infer<typeof AnimSchema>
export const AccentSchema = z.enum(['none', 'accent', 'warn', 'ok'])
export type Accent = z.infer<typeof AccentSchema>
const StateCfgSchema = z.object({ anim: AnimSchema, accent: AccentSchema })
export type PetStateConfig = z.infer<typeof StateCfgSchema>
const defaultStates = (): Record<PetState, PetStateConfig> => ({
  idle: { anim: 'float', accent: 'none' },
  working: { anim: 'spin-halo', accent: 'none' },
  confirm: { anim: 'alert', accent: 'warn' },
  input: { anim: 'tilt', accent: 'accent' },
  done: { anim: 'pulse-ok', accent: 'ok' }
})
// A single user-defined custom pet — either emoji-based (emoji+color) or image-pack-based (per-state
// images), or both. `id` is a stable client-generated key used to select/delete it.
export const CustomPetSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().optional(),
  color: z.string().optional(),
  images: z.partialRecord(z.enum(PET_STATES), z.string()).optional(),
})
export type CustomPetCfg = z.infer<typeof CustomPetSchema>

export const PetSchema = z.object({
  enabled: z.boolean(),
  skin: z.enum(['sprite', 'bot', 'ghost', 'custom']),
  // Bundled pet entries plus user-defined custom pets; `activeCustomPetId` picks which one shows when skin==='custom'.
  customPets: z.array(CustomPetSchema).max(PET_CUSTOM_MAX).default(() => []),
  activeCustomPetId: z.string().optional(),
  // Legacy singular custom fields — kept for back-compat parsing of old on-disk configs; used as a
  // fallback only when customPets is empty (see resolveActiveCustomPet in shared/petCustom).
  // Keyed by pet state (idle/working/…); partial — only states the user supplied an image for.
  customImages: z.partialRecord(z.enum(PET_STATES), z.string()).optional(),
  // Emoji-based custom skin imported via JSON ({ name, emoji, color }). Used when skin==='custom'
  // and no per-state image is set.
  customEmoji: z.object({ name: z.string(), emoji: z.string(), color: z.string() }).optional(),
  corner: z.enum(['right', 'left']),
  pos: z.object({ bottom: z.number() }).default({ bottom: 24 }),
  // Free desktop position: ABSOLUTE global screen coords of the collapsed window's top-left (spans all
  // monitors). When set, overrides corner docking so the pet stays wherever it was dragged — including
  // on a secondary display; absent = legacy corner dock on the primary display.
  free: z.object({ x: z.number(), y: z.number() }).optional(),
  // Follow-cursor: when on, the pet hops to whichever display the cursor is on, at the same relative
  // position — handy across multiple monitors/desktops. .default keeps old on-disk configs parsing.
  followCursor: z.boolean().default(false),
  // Sprite size multiplier (drag the hover resize handle). Out-of-range/junk values fall back to 1
  // via .catch so a hand-edited settings.json never fails the WHOLE settings parse.
  scale: z.number().min(PET_SCALE_MIN).max(PET_SCALE_MAX).catch(1).default(1),
  notify: z.object({ confirm: z.boolean(), input: z.boolean(), done: z.boolean() }),
  // Pet interaction style. 'simple' (default): a light collapsible bubble showing running agents /
  // confirm-input / done — click the pet when idle to focus the app. 'full': the legacy popover with the
  // workspace list, session browser and command box. .default keeps old on-disk configs parsing.
  interactionMode: z.enum(['full', 'simple']).default('simple'),
  states: z.object({
    idle: StateCfgSchema, working: StateCfgSchema, confirm: StateCfgSchema,
    input: StateCfgSchema, done: StateCfgSchema
  }).default(defaultStates)
})
export type Pet = z.infer<typeof PetSchema>
const defaultSkills = (): Record<string, boolean> => ({ 'code-review': true, 'test-driven': true, 'deep-research': false, 'systematic-debugging': true })
const defaultPet = (): Pet => ({ enabled: true, skin: 'custom', customPets: builtinPets(), activeCustomPetId: `builtin-${DEFAULT_BUILTIN_PET_ID}`, corner: 'right', pos: { bottom: 24 }, followCursor: false, scale: 1, notify: { confirm: true, input: true, done: false }, interactionMode: 'simple', states: defaultStates() })
export const HeartbeatSchema = z.object({
  stallMs: z.number().int().positive().default(90_000),
  killGraceMs: z.number().int().positive().default(60_000),
  pingMs: z.number().int().positive().default(15_000),
}).default(() => ({ stallMs: 90_000, killGraceMs: 60_000, pingMs: 15_000 }))
const defaultHeartbeat = () => ({ stallMs: 90_000, killGraceMs: 60_000, pingMs: 15_000 })
export const TerminalSchema = z.object({
  fontFamily: z.string().default("'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace"),
  fontSize: z.number().default(12.5),
}).default({ fontFamily: "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace", fontSize: 12.5 })
export type Terminal = z.infer<typeof TerminalSchema>

// 关闭主窗口行为:ask=每次询问(默认) / hide=缩小到 Dock(隐藏窗口,应用后台运行) / quit=退出应用。
// .catch 让手改 settings.json 的垃圾值回落 ask 而不是让整份 settings 解析失败。
export const CloseActionSchema = z.enum(['ask', 'hide', 'quit']).catch('ask').default('ask')
export type CloseAction = z.infer<typeof CloseActionSchema>

export const DockIconSchema = z.enum(['ice-cyan', 'forge-aurora', 'cobalt-violet', 'ember-violet', 'magenta-pulse']).catch('ember-violet').default('ember-violet')
export type DockIcon = z.infer<typeof DockIconSchema>
export const AppIconSchema = z.object({
  dockIcon: DockIconSchema,
  showMenuBar: z.boolean().default(false),
}).default(() => ({ dockIcon: 'ember-violet' as const, showMenuBar: false }))
export type AppIcon = z.infer<typeof AppIconSchema>

// Native OS notifications — master switch + per-type (mirrors pet.notify). Fired only when the
// app window is unfocused. `done` off by default (completion is lower-urgency than confirm/input).
export const NotificationsSchema = z.object({
  enabled: z.boolean(),
  confirm: z.boolean(),
  input: z.boolean(),
  done: z.boolean(),
})
export type Notifications = z.infer<typeof NotificationsSchema>
const defaultNotifications = (): Notifications => ({ enabled: true, confirm: true, input: true, done: true })

// Keyboard shortcuts. We store ONLY user overrides keyed by action id (the default binding for each
// action lives in shared/keybindings.ts KEYBINDING_ACTIONS — the single source of truth). An override
// value of '' means the action was explicitly unbound. Absent id → fall back to its registry default,
// so adding a new action ships its default to every existing user with no migration.
export const KeybindingsSchema = z.object({
  overrides: z.record(z.string(), z.string()).default(() => ({})),
}).default(() => ({ overrides: {} }))
export type Keybindings = z.infer<typeof KeybindingsSchema>

export const SettingsSchema = z.object({
  appearance: AppearanceSchema,
  notifications: NotificationsSchema.default(defaultNotifications),
  closeAction: CloseActionSchema,
  appIcon: AppIconSchema,
  termProxy: z.string(),
  skills: SkillsSchema.default(defaultSkills),
  pet: PetSchema.default(defaultPet),
  heartbeat: HeartbeatSchema,
  // Ordered list of pinned workspace paths (kept at the top of the sidebar). Max 5 enforced in IPC.
  pinnedWorkspaces: z.array(z.string()).default(() => []),
  // User's manual drag order for the (non-pinned) workspace list. Paths not listed fall back to
  // registry order after the ordered ones.
  workspaceOrder: z.array(z.string()).default(() => []),
  // Last workspace the user was in — the titlebar's 工作区 tab restores it (its per-workspace
  // activeSessionId then restores the last session for free).
  lastActiveWorkspace: z.string().catch('').default(''),
  // User-pasted usage-plugin credentials, keyed by provider id (e.g. qoder/cursor cookie/token).
  // Overrides the adapter's auto-read source. Stored locally only.
  pluginCreds: z.record(z.string(), z.string()).default(() => ({})),
  terminal: TerminalSchema,
  // Id of the external app chosen in the "打开位置" dropdown (see shared/openers catalog). '' = none yet.
  defaultOpenerId: z.string().catch('').default(''),
  keybindings: KeybindingsSchema,
  // Developer diagnostic: surface main event-loop stall (卡顿) toasts in the notification bell.
  // Off by default — real stalls are still written to the debug log regardless; this only controls
  // whether they pop as user-facing notifications (opt-in from the 调试 pane).
  perfStallToast: z.boolean().catch(false).default(false),
})
export type Settings = z.infer<typeof SettingsSchema>
export const defaultSettings = (): Settings => ({
  appearance: { theme: 'light', accent: 'blue', vibrancy: false, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 'medium', bgImage: '', bgScope: 'off', bgOpacity: 0.35, homeBgImage: '', homeBgOn: false, homeBgOpacity: 0.35 },
  notifications: defaultNotifications(),
  closeAction: 'ask',
  appIcon: { dockIcon: 'ember-violet', showMenuBar: false },
  termProxy: '',
  skills: defaultSkills(),
  pet: defaultPet(),
  heartbeat: defaultHeartbeat(),
  pinnedWorkspaces: [],
  workspaceOrder: [],
  lastActiveWorkspace: '',
  pluginCreds: {},
  terminal: { fontFamily: "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace", fontSize: 12.5 },
  defaultOpenerId: '',
  keybindings: { overrides: {} },
  perfStallToast: false,
})

export const ProjectSchema = z.object({
  id: z.string(), name: z.string(), repoUrl: z.string(), defaultBranch: z.string().default('main')
})
export type Project = z.infer<typeof ProjectSchema>
export const ProjectsSchema = z.object({ projects: z.array(ProjectSchema) })
export const defaultProjects = () => ({ projects: [] as Project[] })

export const StageConfigSchema = z.object({
  // key 是任意字符串(自定义阶段);内置 key 仍作默认回退。name/prompt/行为开关可选,缺省走内置默认。
  key: z.string(), defaultAgent: z.string(), defaultModel: z.string(),
  name: z.string().optional(),                        // 自定义显示名(内置回退 STAGE_NAMES)
  prompt: z.string().optional(),                      // 内置=追加段;自定义=完整正文
  scope: z.enum(['root', 'per-project']).optional(),
  gate: z.boolean().optional(),
  review: z.lazy(() => ReviewConfigSchema).optional(),
  summary: z.boolean().optional(),                    // per-project 后追加汇总代理
  projectAgent: z.boolean().optional(),               // 用各项目自己的 provider/model
  producesDoc: z.boolean().optional(),                // 强制写 markdown 方案文件
})
export const WorkflowSchema = z.object({
  id: z.string(), name: z.string(), stages: z.array(StageConfigSchema).min(1),
  plugins: z.array(PluginSchema).default(() => []),
  stagePrompts: z.record(z.string(), z.string()).default(() => ({})),   // 模板级追加段(按 stage key),只给创建向导播种
})
export type Workflow = z.infer<typeof WorkflowSchema>
export const WorkflowsSchema = z.object({ workflows: z.array(WorkflowSchema) })
export const standardWorkflow = (): Workflow => ({
  id: 'standard', name: '标准工作流',
  stages: STAGE_KEYS.map(k => ({ key: k, defaultAgent: 'claude', defaultModel: 'opus-4.8' })),
  plugins: [], stagePrompts: {}
})
export const defaultWorkflows = () => ({ workflows: [standardWorkflow()] })

export const ModelSchema = z.object({ id: z.string(), label: z.string(), description: z.string().optional() })
export const ProviderConfigSchema = z.object({
  id: z.string(),
  binOverride: z.string().default(''),   // override the CLI bin path for a built-in provider
  env: z.record(z.string(), z.string()).default({}),
  modelsCache: z.array(ModelSchema).default([]),
  modelsFetchedAt: z.number().default(0),
  // Last-good DETECTION snapshot, persisted so agents survive an app upgrade/relaunch and a flaky/slow
  // cold-start probe doesn't make them vanish. Only an explicit 重新检测 (force) clears a stale one.
  detectedInstalled: z.boolean().optional(),
  detectedBinPath: z.string().optional(),
  detectedVersion: z.string().optional(),
  detectedAt: z.number().optional(),
})
// A user-added agent: an arbitrary CLI invoked per a simple args template.
export const CustomAgentSchema = z.object({
  id: z.string(), displayName: z.string(), bin: z.string(),
  argsTemplate: z.string().default('{prompt}'),   // {prompt} {model} {cwd} placeholders
  models: z.array(ModelSchema).default([])
})
export const AgentsConfigSchema = z.object({
  providers: z.array(ProviderConfigSchema).default(() => []),
  custom: z.array(CustomAgentSchema).default(() => [])
})
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>
export type CustomAgent = z.infer<typeof CustomAgentSchema>
export const defaultAgentsConfig = (): AgentsConfig => ({ providers: [], custom: [] })

// Code-review (CR) lenses for multi-lens parallel review: each reviewer审一个视角。
export const REVIEW_LENSES = ['correctness', 'security', 'performance', 'style'] as const
export type ReviewLens = (typeof REVIEW_LENSES)[number]
const ReviewLensSchema = z.enum(REVIEW_LENSES)

// Optional per-workspace shape of the `review` (代码 CR) stage:
//  - single   -> ONE root-scope agent审全工作区聚合变更(agent id 'review')。
//  - parallel -> 多 reviewer 并行:scope 决定怎么扇出(默认 per-project)。
//      · per-project -> 每项目 worktree 一个 reviewer(镜像 develop 扇出),id 'review:<project>'。
//      · workspace + reviewers=lens[] -> 同范围 N 个 reviewer 各审一视角,id 'review:workspace:<lens>'。
// reviewers: number(预留并行度,multi-lens 用 ReviewLens[] 显式指定视角)。absent = 走默认(parallel/per-project)。
export const ReviewConfigSchema = z.object({
  mode: z.enum(['single', 'parallel']),
  scope: z.enum(['workspace', 'per-project']).optional(),
  reviewers: z.union([z.number(), z.array(ReviewLensSchema)]).optional(),
})
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>

// A resolved (post-wizard) enabled stage: provider/model chosen for this workspace.
// The stage's display name is derived from STAGE_NAMES[key] (not stored, to avoid drift).
export const WsStageSchema = z.object({
  // key 任意字符串(自定义阶段);内置 key 走默认回退。缺省字段回退内置默认 → 老 workspace.json 零迁移。
  key: z.string(), provider: z.string(), model: z.string(),
  review: ReviewConfigSchema.optional(),
  prompt: z.string().optional(),   // 内置=追加段(append,非覆盖);自定义=完整正文
  name: z.string().optional(),                        // 自定义显示名(内置回退 STAGE_NAMES)
  scope: z.enum(['root', 'per-project']).optional(),
  gate: z.boolean().optional(),
  summary: z.boolean().optional(),
  projectAgent: z.boolean().optional(),
  producesDoc: z.boolean().optional(),
})
export type WsStage = z.infer<typeof WsStageSchema>
// A selected project enriched with its name (= develop worktree subdir) + per-project develop provider/model.
// name/provider/model default to '' so OLD workspace.json files (which stored only {repoId,branch}) still parse.
export const WsProjectSchema = z.object({
  repoId: z.string(), name: z.string().default(''), branch: z.string(),
  provider: z.string().default(''), model: z.string().default('')
})
export type WsProject = z.infer<typeof WsProjectSchema>
export const WorkspaceSchema = z.object({
  name: z.string(), path: z.string(),
  workflowId: z.string(),
  stages: z.array(WsStageSchema).default(() => []),   // resolved, ordered enabled stages (back-compat: absent → [])
  projects: z.array(WsProjectSchema),                 // selected projects + per-project develop provider/model
  status: z.enum(['idle', 'run', 'ok', 'err']).default('idle'),
  plugins: z.array(PluginSchema).default(() => []),   // workspace-level plugins (run after every stage)
  stepPlugins: z.array(PluginSchema).default(() => []), // stage-scoped plugins (keyed by plugin.after)
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export const WorkspaceRegistryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  createdAt: z.number().default(0),
  archived: z.boolean().default(false),
  archivedAt: z.number().nullable().default(null),
  description: z.string().default(''),
})
export type WorkspaceRegistryEntry = z.infer<typeof WorkspaceRegistryEntrySchema>
export const WorkspaceRegistrySchema = z.object({ workspaces: z.array(WorkspaceRegistryEntrySchema) })
export const defaultWorkspaceRegistry = () => ({ workspaces: [] as WorkspaceRegistryEntry[] })
