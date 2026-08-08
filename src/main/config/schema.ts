import { z } from 'zod'
import type { Plugin as SharedPlugin, LibraryHook as SharedLibraryHook } from '../../shared/plugin'
import { PET_SCALE_MIN, PET_SCALE_MAX } from '../../shared/petGeometry'
import { builtinPets } from '../../shared/builtinPets'
import { PET_CUSTOM_MAX } from '../../shared/petCustom'
import { GROWTH_ACTIONS } from '@shared/growthPet'

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
  requirement: '拆解本次需求,明确目标、范围边界与验收标准;识别关键风险与待澄清的问题。**产出(必须)两部分,并用 forge_write_artifact 登记为一个 markdown 文件(kind=md):①【需求理解】你如何理解本需求(供用户在评审门快速核对是否跑偏,在此拦截"我要 ABC 你却做成 BCD");②【关联清单】本需求相关的文件/模块/入口路径,供后续设计/开发直接定位,避免它们重扫全仓。** 以理解和定位为主:按需查看关键入口/相关代码来编好关联清单,但不要对整个仓库穷尽式通读或审计;判据是"你能说清这个需求会碰到哪些地方"即可,尽快产出,不要把时间耗在全仓浏览上。',
  design: '基于需求产出技术方案:模块划分、接口/数据结构设计、关键技术决策与替代方案,并评估技术风险与影响面。**探查(重要):上游若给了【关联清单】,就从清单里的文件/模块出发重点阅读,必要时再顺藤摸瓜——不要对整个仓库重新穷尽式通读(那是重复劳动,又慢又耗 token)。判据是"能说清方案影响面"即可。** **各项目分工(必须,当本工作流涉及多个项目/仓库时——项目列表见对话中告知):技术方案里必须包含一节「## 📋 各项目任务分工」(标题保留 📋 图标),在其下为每个项目单列一个带 📁 图标的 `### 📁 <项目名>` 子节——这些图标是刻意加的视觉标识,让用户在渲染后一眼分辨"这是分工块、这是哪个项目"。**必须为每一个项目都单列一节(哪怕它本次无需改动):若某项目本次不需要开发,也要保留它的 `### 📁 <项目名>` 子节,并在其中明确写『**目标：** 本次无需改动』并简述原因——不要省略该项目,便于用户核对、也便于后续跳过它的开发。** 每个需要改动的子节要让用户一眼看清该项目要做什么——用清晰可扫读的结构:开头一句『**目标：**…』(目标二字加粗),随后用要点列表逐条写具体改动(每条=做什么 + 涉及的文件/模块/接口),必要时标注依赖或先后顺序。整体方案与各项目分工都放在同一份文档里(不要拆成多个文件),因为代码阶段每个项目的 agent 会读这同一份完整方案、并定位到自己那一节。** **无论你用什么方法或 spec(自由发挥、各类计划/规格流程等)来推演方案,最终都必须把完整方案(含上面的各项目分工)汇总落到这同一份技术方案文档里;不要让交付物散落到其他文件/目录,否则代码阶段读不到。** **产出方式(必须):把完整技术方案写成一个 markdown 文件,并调用 forge_write_artifact 登记它(kind=md)——不要只把方案正文写在回复里,否则下游拿不到方案。**',
  develop: '按技术方案实现代码变更,遵循项目既有规范与目录约定;保持改动聚焦、可回滚,并在必要处补充说明性注释。**探查:参考上游【技术方案】与【关联清单】直接定位相关部分动手,不要为了改动先把整个仓库重扫一遍。**',
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
// 强制写 markdown 交付文件(否则该阶段判失败,不糊弄):design=技术方案;requirement=需求理解+关联清单
// (关联清单必须落成可被下游读取的产物,设计/开发才能从清单出发、不重扫全仓——工作流减重的关键)。
export const DEFAULT_STAGE_PRODUCES_DOC: Record<string, boolean> = { requirement: true, design: true }
export const DEFAULT_STAGE_SUMMARY: Record<string, boolean> = { design: true }               // per-project 后追加汇总代理

// 字号从旧的枚举(小/中/大)升级为具体 px 数值。旧配置里的字符串按下表兼容映射,新值直接存数字。
export const LEGACY_APP_FONT_PX: Record<string, number> = { small: 13, medium: 14, large: 15.5 }
export const LEGACY_CHAT_FONT_PX: Record<string, number> = { small: 12.5, medium: 14, large: 16 }
const fontSizePx = (legacy: Record<string, number>, def: number) =>
  z.preprocess(v => (typeof v === 'string' ? (legacy[v] ?? def) : v), z.number().min(9).max(28).catch(def)).default(def)

export const AppearanceSchema = z.object({
  theme: z.enum(['dark', 'light', 'auto', 'midnight', 'sepia', 'forest']),
  accent: z.enum(['blue', 'violet', 'indigo', 'cyan', 'teal', 'emerald', 'lime', 'amber', 'orange', 'rose', 'magenta', 'graphite', 'custom']).default('blue'),
  // 'custom' 强调色的实际取值(#rrggbb)。仅当 accent==='custom' 生效;applyTheme 据此写内联 --accent/--accent-dim/
  // --run/--on-accent(其余深浅色都在各 CSS 站点用 color-mix 从 --accent 现算,故只需喂这几个基色)。可选,老配置无此字段。
  accentCustom: z.string().optional(),
  // 「跟随壁纸配色」开着时,强调色是否也跟随壁纸。false = 底色/明暗仍跟壁纸,但强调色改听 accent 那一项。
  // 复用的是灰度壁纸早就走通的那条路径(hueAccent=null → paletteVars 不产出 accent 四件套,交还给用户设置)。
  // 刻意用 optional 而不是 .default(true):缺省即「跟随」,老配置和各处 Appearance 字面量都不用动。
  wallpaperAccentAuto: z.boolean().optional(),
  // 主题皮肤(叠加层):内置皮肤 id(见 src/shared/skins.ts)。applyTheme 据此在根节点打 data-skin,
  // skins.css 的 :root[data-skin=id] 块覆盖整套中性色+accent。null/缺省 = 不套皮肤,用用户原本的 theme/accent。
  // 纯叠加,不改写其它外观字段;清空即还原。可选,老配置无此字段。
  activeSkin: z.string().nullable().optional(),
  // 壁纸自动配色:打开后从当前壁纸取「主调色相 + 点缀色相」,套进已验证的明度阶梯生成一整套临时皮肤
  // (明暗也按壁纸亮度定),接管基础主题/强调色/手选皮肤。配色本身不落盘 —— 换壁纸即重算,关掉即还原。
  // 取色与生成规则见 src/renderer/theme/wallpaperPalette.ts。
  autoWallpaperTheme: z.boolean().default(false),
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
  // fontSize:应用整体(界面)字号,px 数值(如 11 / 11.5 / 14)。会话区(消息输入/输出)字号由
  // chatFontSize 单独控制、互不影响;终端字号仍在 terminal.fontSize。旧枚举值自动兼容为 px。
  fontSize: fontSizePx(LEGACY_APP_FONT_PX, 14),
  chatFontSize: fontSizePx(LEGACY_CHAT_FONT_PX, 14),
  // 会话区排版微调(独立于字号):行距(line-height 倍数)与字间距(letter-spacing,em)。默认取偏舒展的
  // 1.7 行距 + 0 字间距(更接近 codex 那种协调、透气的观感);用户可各自拉动。越界/非法回落默认。
  chatLineHeight: z.preprocess((v) => (typeof v === 'number' ? Math.min(2.2, Math.max(1.3, v)) : 1.7), z.number().catch(1.7).default(1.7)),
  chatLetterSpacing: z.preprocess((v) => (typeof v === 'number' ? Math.min(0.08, Math.max(-0.02, v)) : 0), z.number().catch(0).default(0)),
  // 内嵌 HTML:打开后(1)给对话 provider 注入格式指令,鼓励它在对比矩阵/流程结构/信息卡片这类场景内嵌
  // HTML 片段;(2)渲染端把片段按白名单重建成真元素,配色映射到本应用的 token,于是卡片跟随皮肤和壁纸
  // 自动配色。默认关 —— 它会显著增加输出 token,且收益随对话内容而定,由用户自己决定要不要常开。
  chatInlineHtml: z.boolean().catch(false).default(false),
  // 应用整体字体族(逗号分隔备选)。'' = 跟随系统栈。作用于 --font,不影响终端字体。
  fontFamily: z.string().catch('').default(''),
  // 正文基础字重(数值,300–600,步进 25)。只作用于 body 基础字重(--app-fw),不动已显式加重的
  // 标题/强调文本。旧枚举值自动迁移:'normal'→400、'medium'→450;非法/越界值回落 450 并吸附到步进网格。
  textWeight: z.preprocess((v) => {
    const n = v === 'normal' ? 400 : v === 'medium' ? 450 : typeof v === 'number' ? v : 450
    return Math.min(600, Math.max(300, Math.round(n / 25) * 25))
  }, z.number().catch(450).default(450)),
  // 背景图:用户上传的图片落盘到 ~/.myFlowForge/backgrounds/,此处只存 forge-bg:// URL(不再内联 base64,
  // 故无 6MB 上限)。bgScope 决定铺在整个应用还是仅会话区;'off' 或空图 = 关闭。bgOpacity 是图片层的可见度
  // (其上有一层底色蒙版保证正文可读)。
  bgImage: z.string().default(''),
  bgScope: z.enum(['off', 'app', 'chat']).default('off'),
  bgOpacity: z.number().min(0.05).max(1).default(0.35),
  // 当前应用的「内置壁纸」id(仅用于在壁纸库里高亮当前项);用户上传自己的图或清除背景时置空。
  bgWallpaperId: z.string().default(''),
  // 首页 (home) 背景图:独立于上面的应用/会话区背景,可同可不同。homeBgOn 是首页背景的独立开关,
  // homeBgImage 同样存 forge-bg:// URL,homeBgOpacity 是首页图片层的可见度。首页上此背景盖过 'app' 范围背景。
  homeBgImage: z.string().default(''),
  homeBgOn: z.boolean().default(false),
  homeBgOpacity: z.number().min(0.05).max(1).default(0.35),
  // 壁纸纵向焦点(0–100,%):`background-size:cover` 把图铺满窗口后要裁掉溢出部分,这个值决定纵向从哪里裁 ——
  // 0=顶部对齐(保住画面上部/人物头部,裁底)、50=居中、100=底部对齐。按【图片 URL】分别记忆,故换壁纸各调各的
  // (解决"有些竖构图壁纸被削头")。缺省 = DEFAULT_BG_POSITION(略偏上)。app/会话区背景与首页背景都查这张表。
  bgPositions: z.record(z.string(), z.number().min(0).max(100)).catch({}).default({})
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
const GrowthActionCfgSchema = z.object({
  row: z.number().int().min(0),
  durations: z.array(z.number().positive()).min(1),
})
const GrowthPackSchema = z.object({
  atlas: z.object({
    cols: z.number().int().positive(),
    cellW: z.number().int().positive(),
    cellH: z.number().int().positive(),
  }),
  actions: z.partialRecord(z.enum(GROWTH_ACTIONS), GrowthActionCfgSchema),
  stages: z.array(z.object({
    at: z.number().min(0).max(1),
    name: z.string().optional(),
    sheet: z.string(),
  })).min(1),
})

// A single user-defined custom pet — either emoji-based (emoji+color) or image-pack-based (per-state
// images), or both. `id` is a stable client-generated key used to select/delete it.
export const CustomPetSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().optional(),
  color: z.string().optional(),
  images: z.partialRecord(z.enum(PET_STATES), z.string()).optional(),
  atlas: z.object({ path: z.string(), version: z.number() }).optional(),
  // .catch(undefined) 与下面的 growthDailyGoal 同一条理由,但后果更重:settings.json 是一整份
  // 解析的,这里抛一次,store.readJson 的 catch 就会把【整份设置】换成 defaultSettings() —— 用户
  // 的工作区、皮肤、快捷键一次性回到出厂,下次写盘还会把这个结果固化下来。一个坏宠物包(作者手改
  // pet.json、旧版本写下的字段)不该有这种爆炸半径,所以坏 growth 块只丢它自己,退成 undefined
  // (宠物还在,只是不再按成长包渲染),其余设置原封不动。
  growth: GrowthPackSchema.optional().catch(undefined),
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
  // Follow-cursor: when on, the pet hops to whichever display the cursor is on AND its eyes track the
  // cursor (a 7Hz gaze poll). Off = the pet ignores the cursor entirely (no display-hop, no gaze poll),
  // which removes a continuous idle wakeup. .default keeps old on-disk configs parsing.
  followCursor: z.boolean().default(true),
  // Idle animation: when on (default), the idle pet keeps breathing (sprite frame loop + float bob).
  // Off = the idle pet holds a single still frame, so it stops re-rendering ~5.5×/s when nothing is
  // happening — the biggest idle-power saver for users who want a calmer/greener pet.
  idleAnimation: z.boolean().default(true),
  // Sprite size multiplier (drag the hover resize handle). Out-of-range/junk values fall back to 1
  // via .catch so a hand-edited settings.json never fails the WHOLE settings parse.
  scale: z.number().min(PET_SCALE_MIN).max(PET_SCALE_MAX).catch(1).default(1),
  // 成长宠物的「每日 token 目标」= 进度的分母。留空 = 自动按过去若干天的用量中位数推算。
  // .catch 让手改坏的 settings.json 退回自动,而不是整份设置解析失败。
  growthDailyGoal: z.number().int().positive().optional().catch(undefined),
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
const defaultPet = (): Pet => ({ enabled: true, skin: 'ghost', customPets: builtinPets(), activeCustomPetId: undefined, corner: 'right', pos: { bottom: 24 }, followCursor: true, idleAnimation: true, scale: 1, notify: { confirm: true, input: true, done: false }, interactionMode: 'simple', states: defaultStates() })
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

// 记忆功能总开关。默认开(保持现有三层记忆行为);关闭是非破坏性的——只暂停读(注入前言)与写
// (蒸馏),磁盘上的 system.md/workspace.md/session summary 原样保留。用对象包裹便于将来加子标志。
// 默认【关闭】:记忆蒸馏会在每轮后用当前 provider CLI 跑额外的一次性 LLM 调用(消耗 token、走用户额度),而同
// provider/同 session 的原生 --resume 本就带完整上下文、蒸馏多为冗余。改成用户按需开启(开启处提示会费 token)。
// .catch/.default(false) 只影响【未显式设过】的配置;已手动开过的用户保留其 true。
export const MemorySchema = z.object({ enabled: z.boolean().catch(false).default(false) })
export const defaultMemory = (): z.infer<typeof MemorySchema> => ({ enabled: false })

// Bot bridge (钉钉/Telegram/飞书): connects an external chat bot to the app so a phone can answer
// gates, see results, and drive sessions. Credentials + bindings + short-id state persist here (local
// only, plaintext — same as pluginCreds/nsfwCode). See src/main/bot/. Design: docs .../bot-bridge.
export const BotBindingSchema = z.object({
  platform: z.enum(['dingtalk', 'telegram', 'feishu']),
  chatId: z.string(),
  chatType: z.enum(['private', 'group']).catch('private').default('private'),
  userId: z.string().optional(),
  robotCode: z.string().optional(),
  focus: z.object({ workspacePath: z.string(), sessionId: z.string() }).nullable().catch(null).default(null),
  boundAt: z.number().catch(0).default(0),
})
// Migrate the pre-multi-platform shape ({ enabled, dingtalk:{clientId,clientSecret} }) into the
// per-platform shape so an existing settings.json keeps its DingTalk connection after upgrade.
const migrateBotBridge = (v: unknown): unknown => {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const dt = o.dingtalk as Record<string, unknown> | undefined
    if (dt && typeof dt === 'object' && !('enabled' in dt) && 'enabled' in o) {
      o.dingtalk = { ...dt, enabled: !!o.enabled }
    }
  }
  return v
}
export const BotBridgeSchema = z.preprocess(migrateBotBridge, z.object({
  dingtalk: z.object({
    enabled: z.boolean().catch(false).default(false),
    clientId: z.string().catch('').default(''), clientSecret: z.string().catch('').default(''),
  }).catch({ enabled: false, clientId: '', clientSecret: '' }).default(() => ({ enabled: false, clientId: '', clientSecret: '' })),
  telegram: z.object({
    enabled: z.boolean().catch(false).default(false), botToken: z.string().catch('').default(''),
  }).catch({ enabled: false, botToken: '' }).default(() => ({ enabled: false, botToken: '' })),
  feishu: z.object({
    enabled: z.boolean().catch(false).default(false),
    appId: z.string().catch('').default(''), appSecret: z.string().catch('').default(''),
  }).catch({ enabled: false, appId: '', appSecret: '' }).default(() => ({ enabled: false, appId: '', appSecret: '' })),
  verbosity: z.enum(['essential', 'stages', 'verbose']).catch('essential').default('essential'),
  pairingCode: z.string().catch('').default(''),
  bindings: z.array(BotBindingSchema).catch([]).default(() => []),
  ids: z.object({
    seq: z.number().catch(0).default(0),
    ws: z.record(z.string(), z.string()).catch({}).default(() => ({})),
    session: z.record(z.string(), z.string()).catch({}).default(() => ({})),
  }).catch({ seq: 0, ws: {}, session: {} }).default(() => ({ seq: 0, ws: {}, session: {} })),
}))
export const defaultBotBridge = (): z.infer<typeof BotBridgeSchema> => ({
  dingtalk: { enabled: false, clientId: '', clientSecret: '' },
  telegram: { enabled: false, botToken: '' },
  feishu: { enabled: false, appId: '', appSecret: '' },
  verbosity: 'essential', pairingCode: '', bindings: [], ids: { seq: 0, ws: {}, session: {} },
})

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
  // Provider ids the user has disabled in 设置 → 编码代理. Disabled providers are hidden from every
  // "选择编码代理" list (their CLIs stay installed), but the settings pane still lists them so the
  // user can re-enable. Matches built-in and custom agents by id.
  disabledProviders: z.array(z.string()).catch([]).default(() => []),
  terminal: TerminalSchema,
  // Id of the external app chosen in the "打开位置" dropdown (see shared/openers catalog). '' = none yet.
  defaultOpenerId: z.string().catch('').default(''),
  keybindings: KeybindingsSchema,
  // Developer diagnostic: surface main event-loop stall (卡顿) toasts in the notification bell.
  // Off by default — real stalls are still written to the debug log regardless; this only controls
  // whether they pop as user-facing notifications (opt-in from the 调试 pane).
  perfStallToast: z.boolean().catch(false).default(false),
  // Developer diagnostic: run the event-loop stall monitor (a 50ms sampling interval). OFF by default —
  // that sampler wakes the main event loop 20×/s continuously, which alone prevents CPU idle / App Nap,
  // so it must not run in a normal (packaged) session. Turn on only when diagnosing 卡顿; see index.ts.
  perfDiagnostics: z.boolean().catch(false).default(false),
  // License-gated extra content (see shared/nsfw.ts). nsfwUnlocked flips true after a valid activation
  // code. nsfwCodes holds ALL activated codes (multi-code additive: the app joins them and the Worker
  // returns the union of their content subsets). nsfwCode is the LEGACY single code, kept for migration
  // (read fallback: an old install with only nsfwCode set behaves as nsfwCodes=[nsfwCode]).
  nsfwUnlocked: z.boolean().catch(false).default(false),
  nsfwCode: z.string().catch('').default(''),
  nsfwCodes: z.array(z.string()).catch([]).default([]),
  // Which gated items have been installed → their local ref (bg: forge-bg:// URL; pet: local customPets
  // id). Drives the 安装/设置 button state; a missing/deleted local file just re-downloads on 设置.
  nsfwInstalled: z.record(z.string(), z.string()).catch({}).default({}),
  // Provider ids the user has one-time acknowledged to run with FULL access in a given workspace,
  // for coding agents that ignore the permission档 and run unrestricted (cursor/gemini/opencode/
  // qwen/copilot). Once allowed for a workspace we don't re-prompt. Keyed: workspacePath → provider ids.
  fullAccessAck: z.record(z.string(), z.array(z.string())).catch({}).default(() => ({})),
  memory: MemorySchema.default(defaultMemory),
  botBridge: BotBridgeSchema.default(defaultBotBridge),
  // codex 驱动通路:'exec' = 现有的一次性 CLI 子进程调用(默认,稳定);'app-server' = 新的常驻
  // JSON-RPC app-server 传输(见 codexRpc.ts),支持权限交互等更细粒度控制。先落地开关,接线在后续任务。
  codexTransport: z.enum(['exec', 'app-server']).catch('exec').default('exec'),
})
export type Settings = z.infer<typeof SettingsSchema>
export const defaultSettings = (): Settings => ({
  appearance: { theme: 'light', accent: 'blue', autoWallpaperTheme: false, vibrancy: false, glass: false, windowOpacity: 1, blurAmount: 0, density: 'comfortable', fontSize: 14, chatFontSize: 14, chatLineHeight: 1.7, chatLetterSpacing: 0, chatInlineHtml: false, fontFamily: '', textWeight: 450, bgImage: '', bgScope: 'off', bgOpacity: 0.35, bgWallpaperId: '', homeBgImage: '', homeBgOn: false, homeBgOpacity: 0.35, bgPositions: {} },
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
  disabledProviders: [],
  terminal: { fontFamily: "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, ui-monospace, monospace", fontSize: 12.5 },
  defaultOpenerId: '',
  keybindings: { overrides: {} },
  perfStallToast: false,
  perfDiagnostics: false,
  nsfwUnlocked: false,
  nsfwCode: '',
  nsfwCodes: [],
  nsfwInstalled: {},
  fullAccessAck: {},
  memory: { enabled: false },
  botBridge: defaultBotBridge(),
  codexTransport: 'exec',
})

export const ProjectSchema = z.object({
  // alias: an optional user-set nickname, purely a search aid — the 新建工作区 project picker matches on
  // name OR alias so a large library (三四十个项目) is quick to find. Defaults to '' so every existing
  // on-disk projects.json stays valid without migration.
  id: z.string(), name: z.string(), repoUrl: z.string(), defaultBranch: z.string().default('main'), alias: z.string().optional()
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
  permissionMode: z.enum(['readonly', 'auto', 'full']).optional(),  // 每阶段权限档(未设 → 回退运行级);见 shared/permissions.ts
  // —— 全局自定义阶段库引用 ——
  // 若本阶段项带 libId,即为对全局库(customStages.json)某条定义的引用:name/agent/model/prompt/flags
  // 在物化 / 显示时由库定义解析提供(shared/customStages.ts resolveStages)。key/name 仍冗余保留作缓存
  // 兜底,库项被删后引用不至于崩溃。见 #「自定义工作流阶段全局库」。
  libId: z.string().optional(),
})
export type StageConfig = z.infer<typeof StageConfigSchema>

// —— 全局自定义阶段库条目 ——
// StageConfigSchema 全字段 + 必填 id(稳定引用键)+ 必填 name(库里每条都得有名字)。存于
// customStages.json;模版的阶段项通过 libId 引用它,编辑一次处处生效(resolver 在物化 / 显示时解析)。
export const CustomStageSchema = StageConfigSchema.extend({
  id: z.string(),
  name: z.string(),
})
export type CustomStage = z.infer<typeof CustomStageSchema>
export const CustomStagesFileSchema = z.object({ stages: z.array(CustomStageSchema).default([]) })
export const defaultCustomStages = () => ({ stages: [] as CustomStage[] })
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
  // User-pinned models (from 设置 → 代理 → 添加模型). These are SACRED: a live `--list-models` refresh
  // must UNION them in, never drop them. Fixes qoder (and any CLI) 自定义模型 vanishing — a user-defined
  // custom model is server/account-specific and never appears in `--list-models`, so a stale refresh used
  // to silently overwrite it away. Kept separate from modelsCache (the auto-detected snapshot) for provenance.
  // Optional (not .default([])) so hand-built ProviderConfig literals/older on-disk configs stay valid; every
  // read sites `?? []`.
  customModels: z.array(ModelSchema).optional(),
  // Per-provider timezone (IANA name, e.g. 'Asia/Shanghai'). Injected as env.TZ when spawning this
  // provider so its runtime clock matches the user's chosen region. Empty/absent = follow system TZ.
  timezone: z.string().optional(),
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
  permissionMode: z.enum(['readonly', 'auto', 'full']).optional(),  // 每阶段权限档(未设 → 回退运行级)
})
export type WsStage = z.infer<typeof WsStageSchema>

// 一条工作区级工作流:名字 + 该工作流已固化的阶段(含每阶段 provider/model)。
export const WsWorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  stages: z.array(WsStageSchema).default(() => []),   // 空 → resolveWorkflowStages 按 id 回退全局 workflow
})
export type WsWorkflow = z.infer<typeof WsWorkflowSchema>

// A selected project enriched with its name (= develop worktree subdir) + per-project develop provider/model.
// name/provider/model default to '' so OLD workspace.json files (which stored only {repoId,branch}) still parse.
export const WsProjectSchema = z.object({
  repoId: z.string(), name: z.string().default(''), branch: z.string(),
  provider: z.string().default(''), model: z.string().default(''),
  // 远端地址的**工作区内副本**。真身在全局注册表(~/.myFlowForge/projects.json),但那个目录看起来
  // 就像个应用缓存目录 —— 用户重装 app 时删掉它是很自然的动作。一旦删掉:每个项目的 .git 只是指向
  // 已消失 mirror 的悬空指针(git worktree 模型),而重建所需的 repoUrl 也一起没了 → git 永久失效、
  // 无法自动恢复(真实事故)。branch/provider/model 本来就存在这里,唯独 repoUrl 没存,是这条分工拧了。
  // 存一份在工作区内,就能"读地址 → 重建 mirror → 修复",用户无感。
  // optional 而非 default(''):default 会让**输出类型变成必填**,全仓库每个 WsProject 字面量(含大量
  // 测试)都得跟着改 —— 对一个已经有真实用户的代码库,这个爆炸半径不值当。optional 让老文件、老代码
  // 一行都不用动;读取方一律 `p.repoUrl || ''`。
  repoUrl: z.string().optional(),
  inPlace: z.boolean().optional()   // repo used in place (no clone); its on-disk dir is the user's real repo — never delete on de-select
})
export type WsProject = z.infer<typeof WsProjectSchema>
export const WorkspaceSchema = z.object({
  name: z.string(), path: z.string(),
  workflowId: z.string().default(''),                 // legacy:老文件的单工作流 id(迁移种子);新文件可留空
  stages: z.array(WsStageSchema).default(() => []),    // legacy:老文件的单工作流已解析阶段(迁移种子)
  workflows: z.array(WsWorkflowSchema).default(() => []),  // 新:一组命名工作流,各自固化阶段
  projects: z.array(WsProjectSchema),                 // selected projects + per-project develop provider/model
  // 建区目的:用户创建向导里可填的一句「想做什么」。作为工作区记忆 `## 建区目的` 的种子(见 seedPurposeMemory)。
  // optional(非 default):保持输出类型可选,老工作区文件与各处 Workspace 字面量无需补该字段。
  purpose: z.string().optional(),
  status: z.enum(['idle', 'run', 'ok', 'err']).default('idle'),
  plugins: z.array(PluginSchema).default(() => []),   // workspace-level plugins (run after every stage)
  stepPlugins: z.array(PluginSchema).default(() => []), // stage-scoped plugins (keyed by plugin.after)
  // 「工作流自动启动」:开 = 从 / 菜单选工作流后不弹确认门(LaunchGateCard),直接用默认配置(默认工作流/
  // 全部项目/默认模型)启动;关(缺省/false)= 弹确认门等用户确认。per-workspace。消费点在渲染层
  // WorkspaceView.onPickWorkflow + 自动确认 effect。不影响子代理改代码的权限(那由权限盾牌管)。
})
export type Workspace = z.infer<typeof WorkspaceSchema>

// '__custom' 是「自定义流」的内部 sentinel id,不是给人看的名字。老工作区迁移时若拿它当显示名,界面
// (工作流列表 / 编辑向导 tab)就会露出 `__custom`,困扰用户 → 统一映射为「自定义」。
export function workflowDisplayName(idOrName: string): string {
  return idOrName === '__custom' ? '自定义' : idOrName
}

// 保证 workflows 非空:老文件只有 workflowId+stages 时,包成单条。顺带把任何露出的 '__custom' 内部 id
// 规范成「自定义」显示名(readWorkspace 每次读都跑本函数,是唯一的规范化 choke point)。纯函数,幂等。
export function ensureWorkspaceWorkflows(ws: Workspace): Workspace {
  const fixName = (wf: WsWorkflow): WsWorkflow => wf.name === '__custom' ? { ...wf, name: '自定义' } : wf
  if (ws.workflows.length > 0) return { ...ws, workflows: ws.workflows.map(fixName) }
  const legacy: WsWorkflow = { id: ws.workflowId || 'default', name: workflowDisplayName(ws.workflowId || '工作流'), stages: ws.stages }
  return { ...ws, workflows: [legacy] }
}

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
