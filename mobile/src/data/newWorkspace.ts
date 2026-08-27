import type { CreateWorkspaceOpts, CreateWorkspaceStage } from '../../../src/shared/types'
import { resolveStages, type StageDefById, type StageRef } from '../../../src/shared/customStages'

/**
 * 「新建工作区(极简版)」这一屏的**全部判断**。
 *
 * ★为什么单独一个文件:`mobile/app/new-workspace.tsx` 带 react-native,vitest 的 `mobile`
 *  project 收不了它(根目录 `vitest.config.ts` 写着 include 只到 `mobile/src/**\/*.test.ts`)。
 *  而这一屏最该被钉死的东西 —— **一个名字能不能当目录名**、**拼出来的路径长什么样**、
 *  **表单到底能不能提交** —— 一行 RN 都不需要。仓库里已经有八个同样形状的文件
 *  (`wsTile.ts` / `pasteOffload.ts` / `listContinue.ts` / `htmlParse.ts` …),照它们的样子来。
 *
 * 这里只 import **类型**和 `src/shared` 下的纯函数(`customStages` 自己就写明「不得 import
 * 任何 main / renderer 专有模块」),所以在 node 环境里 import 得动。
 */

// ── 名字校验 ──────────────────────────────────────────────────────────────

/**
 * 工作区名的长度上限(按码点算,不按 UTF-16 长度 —— 一个 emoji 不该算两个字)。
 *
 * ★64 是**我们自己**定的,不是文件系统的极限(多数文件系统是 255 字节)。定得紧一点是因为
 *  这个名字会变成一段路径,而路径还要再往下接项目目录、worktree、`.forge/…`。
 */
export const WS_NAME_MAX = 64

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string }

/**
 * 这个名字能不能当**一层目录名**。
 *
 * ★它不是「好不好看」的校验,是安全校验:这个字符串会被主机拼进路径然后真去建目录
 *  (`git/worktree.ts` 的 `mkdirSync(dirname(worktreePath), { recursive: true })`)。
 *  手机是一条**从网络到文件系统**的路径 —— 名字里放行一个 `/` 或一个 `..`,
 *  「在我选的那个父目录下建一个子目录」就变成了「在这台机器上任意位置建目录」。
 *
 * 每一条拒绝都给一句人话:这一屏的原则是**失败必须看得见**,而不是按钮默默灰着。
 */
export function checkWsName(raw: string): NameCheck {
  const name = (raw ?? '').trim()
  if (!name) return { ok: false, reason: '给这个工作区起个名字' }
  // ★分隔符两种都要挡:主机可能是 Windows(`\` 在那边是分隔符),而校验跑在手机上,
  //  手机不知道对面是什么系统 —— 所以两种都不许,不去猜。
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, reason: '名字里不能有 / 或 \\ —— 这是一个文件夹名,不是路径' }
  }
  if (name.includes('..')) return { ok: false, reason: '名字里不能有 ..(那会跳出你选的那个目录)' }
  if (name.startsWith('.')) return { ok: false, reason: '不能以 . 开头 —— 那会建出一个隐藏文件夹' }
  // 控制字符(含 NUL)。★NUL 在这个仓库里咬过人:`unread.ts` 的分隔符就是一个真 NUL 字节,
  // 显示出来是个空格,肉眼分不出来。粘贴进来的名字里带一个,路径在 C 那一层会被**截断**。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: '名字里有不可见的控制字符,换一个' }
  if ([...name].length > WS_NAME_MAX) return { ok: false, reason: `名字太长了(最多 ${WS_NAME_MAX} 个字)` }
  return { ok: true, name }
}

// ── 路径拼接 ──────────────────────────────────────────────────────────────

/**
 * 父目录 + 名字 → 完整路径。**只拼,不做任何校验**(名字由 `checkWsName` 把关)。
 *
 * ★分隔符跟着 `parent` 走,不跟着手机走:路径属于**那台机器**。手机永远是 POSIX,
 *  拿 `/` 去拼一个 `C:\Users\…` 会造出 `C:\Users/新区` —— 那东西在 Windows 上能建出来,
 *  但之后每一处字符串比较(工作区注册表的 key 就是路径)都对不上,现象是「建完了列表里没有」。
 */
export function joinPath(parent: string, name: string): string {
  // `parent` 里只有反斜杠才判定成 Windows。混着的(`C:/Users`)按 POSIX 走 —— Windows 两种都吃。
  const win = parent.includes('\\') && !parent.includes('/')
  const sep = win ? '\\' : '/'
  // 末尾的分隔符削掉,否则根目录会拼出 `//新区`。
  // ★削完可能是**空串** —— 父目录就是 POSIX 根 `/` 的时候。那时下面这行拼出来正好是 `/新区`,
  //  不需要额外的分支(第一版写了一条 `if (base === '') …`,变异测试证明它是死代码:删掉全绿)。
  //  Windows 的 `C:\` 削完剩 `C:`,同一行拼回 `C:\新区`。
  const base = parent.replace(/[\\/]+$/, '')
  return base + sep + name
}

// ── 目录列表 ──────────────────────────────────────────────────────────────

export type DirEntry = { name: string; dir: boolean }

/**
 * 目录浏览器该显示哪些、按什么顺序。
 *
 * ★主机那边 `listDir` 已经排过一次了,这里**再排一次不是多余**:
 *  ① 这一屏选的是**父目录**,文件一条都不该出现在可点的列表里 —— 万一哪天服务端把
 *     `filesToo` 的默认值改了,或者换了个实现,这里挡住它比「用户点了一个文件当父目录」好;
 *  ② 排序在手机这边钉死,列表顺序就不随主机版本漂。
 */
export function orderBrowseDirs<T extends DirEntry>(entries: T[]): T[] {
  // ★`filter` 已经给了一个新数组,`sort` 就地排的是那一份,入参一个字节都不动 ——
  //  所以**不需要** `.slice()`(第一版加了一个,变异测试证明它是死代码)。
  //  但顺序不能反过来写:`sort` 在前就是在排调用方那个数组了。
  return entries.filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

// ── 主机得先有这些方法 ────────────────────────────────────────────────────

/**
 * 这一屏**非有不可**的六条 channel。少一条就整屏禁用并说明是哪一条 ——
 * 决策 B-2:一个说明了原因的灰按钮,好过一个点下去才报错的亮按钮。
 *
 * ★字面量写死在这里,不去 import `CH`:`CH` 是个对象,拿它当断言基准的话,
 *  改错了 key 测试会跟着一起变(这正是变异测试专治的那种假绿)。
 */
export const NEEDED_METHODS: readonly string[] = [
  'fs:browse',
  'fs:browse-roots',
  'config:list-projects',
  'config:list-workflows',
  'custom-stages:list',
  'workspace:create',
]

/** 对面没有的那几条(顺序照 NEEDED_METHODS,好让提示语稳定)。 */
export function missingMethods(has: ReadonlySet<string>): string[] {
  return NEEDED_METHODS.filter((m) => !has.has(m))
}

// ── 取消 vs. 失败 ─────────────────────────────────────────────────────────

/**
 * 主进程在用户取消时抛的是 `new Error('SETUP_CANCELLED')`(name 也设成 SetupCancelledError)。
 *
 * ★★**跨网关之后 `name` 没了。** `src/shared/remote/protocol.ts` 的 `errorText()` 只取
 *  `e.message`,所以手机这头收到的是一个普通 Error,消息正文就是 `SETUP_CANCELLED`。
 *  桌面端那份判断写的是 `e.name === 'SetupCancelledError'` —— 照抄过来在手机上**永远是 false**,
 *  于是「我自己点的取消」会被红字报成一个失败。所以这里认的是 message。
 */
export const CANCELLED_MARKER = 'SETUP_CANCELLED'

export function classifyCreateError(message: string): 'cancelled' | 'failed' {
  return message.includes(CANCELLED_MARKER) ? 'cancelled' : 'failed'
}

// ── 创建进度 ──────────────────────────────────────────────────────────────

export type SetupEventLike =
  | { type: 'setup:start' }
  | { type: 'provision:start'; project: string; index: number; total: number }
  | { type: 'provision'; project: string; index: number; total: number }
  | { type: 'provision:error'; project: string; index: number; total: number; message: string }
  | { type: 'setup:done' }
  | { type: string }

/**
 * 一条 `workspace:setup` 广播 → 屏幕上那一行字。认不出来的返回 null(= 不动上一行)。
 *
 * ★`index` 是 **0 基**的(`workspaceSetup.ts` 里 `let index = 0`,emit 完才 ++),
 *  给人看要 +1,否则第一个项目显示成「0/2」。
 */
export function setupProgressText(e: SetupEventLike): string | null {
  const p = e as { type: string; project?: string; index?: number; total?: number; message?: string }
  const at = () => `${(p.index ?? 0) + 1}/${p.total ?? 0}`
  switch (p.type) {
    case 'setup:start':
      return '正在建立工作区…'
    case 'provision:start':
      return `正在拉取 ${p.project}(${at()})`
    case 'provision':
      return `${p.project} 好了(${at()})`
    case 'provision:error':
      return `${p.project} 出错:${p.message ?? '未知原因'}`
    case 'setup:done':
      return '收尾中…'
    default:
      return null
  }
}

// ── 能不能提交 ────────────────────────────────────────────────────────────

export type FormState = {
  online: boolean
  missing: string[]
  /** 已经选好的父目录;还没选就是 null */
  parent: string | null
  name: string
  projectCount: number
  workflowId: string | null
  busy: boolean
}

/**
 * 不能提交的**第一条**理由(能提交就返回 null)。按钮旁边就把它显示出来 ——
 * `app/workflow.tsx` 已经是这么做的:提示挨着按钮,而不是让人点下去吃一句服务端报错。
 */
export function whyNotCreate(s: FormState): string | null {
  if (!s.online) return '没连上主机。工作区建在那台机器上,连上才能建。'
  if (s.missing.length) return `这台主机的版本没有:${s.missing.join('、')}`
  if (s.busy) return '正在创建…'
  if (!s.parent) return '先选一个放它的目录'
  const n = checkWsName(s.name)
  if (!n.ok) return n.reason
  // ★**至少一个项目**是硬要求,不是「建议」。
  //  设计文档 §10 开放问题 4 记着:零项目建区时工作区文件夹由谁创建**没有确认过**。
  //  已知的事实只有「有至少一个项目时,`git/worktree.ts:76` 的
  //  `mkdirSync(dirname(worktreePath), { recursive: true })` 会顺带把它建出来」。
  //  与其在手机上开一条没人验证过的路(而且一旦不成立就是**静默失败** —— 界面说建好了,
  //  那台机器上什么都没有),不如按 §7.4 的原意要求选一个项目,把那条路留给电脑端。
  if (s.projectCount === 0) return '至少选一个项目 —— 手机上不做「空工作区」'
  if (!s.workflowId) return '选一个工作流'
  return null
}

// ── 拼 workspace:create 的入参 ────────────────────────────────────────────

export type WorkflowTemplate = { id: string; name: string; stages: StageRef[] }
export type PickedProject = { repoId: string; branch: string }

/** 模板阶段里,哪个 key 是「代码开发」—— 项目自己那份 provider/model 从它身上抄。 */
const DEV_KEY = 'develop'

/**
 * 模板阶段(`config:list-workflows` 回的 `StageConfig`,字段叫 `defaultAgent`/`defaultModel`)
 * → 工作区阶段(`CreateWorkspaceStage`,字段叫 `provider`/`model`)。
 *
 * ★**只有在这里换名**。桌面向导还会拿「已安装的 provider 列表」再兜一层
 *  (装的那个 CLI 没了就退回第一个装着的),手机这边**故意不做**:那需要再拉一份
 *  `agents:detect` 并在小屏上解释「你配的 claude 没装,给你换成了 codex」。
 *  照搬主机上配好的值,是这台机器的主人自己定的 —— 手机不去替他改主意。
 *
 * ★可选字段一律「有才带」:`CreateWorkspaceOpts` 会被 `WorkspaceSchema.parse` 直接写进
 *  `.forge/workspace.json`,带一堆 `undefined` 进去等于把「没配过」写成了「配成了空」。
 */
function toWsStage(s: StageRef): CreateWorkspaceStage {
  return {
    key: s.key,
    provider: s.defaultAgent ?? '',
    model: s.defaultModel ?? '',
    ...(s.name ? { name: s.name } : {}),
    ...(s.prompt ? { prompt: s.prompt } : {}),
    ...(s.review ? { review: s.review } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
    ...(s.gate !== undefined ? { gate: s.gate } : {}),
    ...(s.summary !== undefined ? { summary: s.summary } : {}),
    ...(s.projectAgent !== undefined ? { projectAgent: s.projectAgent } : {}),
    ...(s.producesDoc !== undefined ? { producesDoc: s.producesDoc } : {}),
  }
}

/**
 * 这一屏发给 `workspace:create` 的**全部**内容。
 *
 * 桌面向导发的比这多得多(plugins / stepPlugins / purpose / inPlace / 每阶段单独挑模型 /
 * 每阶段 CR 视角…)。手机故意只发四样:
 * - `name` / `path`:第一步问的。
 * - `workflows`:**就选中的那一个**,阶段照模板抄。手机不编辑阶段(§7.4)。
 * - `projects`:勾中的 repoId + 分支。
 *
 * 没发的东西各有各的理由,都不是「懒得发」:
 * - `plugins` / `stepPlugins` 不发 ⇒ 建区过程中**一个 hook 微代理都不会跑**。那些 hook 会在
 *   建区中途弹交互门(`hook:interact`),而这一屏没有答门的界面 —— 发了等于设计一个会卡死的流程。
 * - `purpose` 不发:这一屏没有这个输入框,发空串反而会往工作区记忆里塞一段空的「建区目的」。
 * - 阶段的 `review` 不自己补默认值:`resolveStages.ts` 的 `DEFAULT_REVIEW_CONFIG` 会在那边补上
 *   四个视角。手机补一份是抄第二遍,以后那边改了这边不会跟着改。
 */
export function buildCreatePayload(a: {
  name: string
  parent: string
  workflow: WorkflowTemplate
  /** `custom-stages:list` 拉回来的全局阶段库,按 id 索引 */
  stageDefs: StageDefById
  projects: PickedProject[]
}): CreateWorkspaceOpts {
  // ★先解库引用再转换。模板里带 `libId` 的阶段**只冗余缓存了 key/name**
  //  (`schema.ts` 的注释写死了这一点),prompt 和行为开关都在全局库里。
  //  不解就发出去 = 这个阶段的提示词和 scope/gate 全部丢掉,而且不会有任何报错。
  const stages = resolveStages(a.workflow.stages, a.stageDefs).map(toWsStage)
  const dev = stages.find((s) => s.key === DEV_KEY)
  return {
    name: a.name,
    path: joinPath(a.parent, a.name),
    workflows: [{ id: a.workflow.id, name: a.workflow.name, stages }],
    // ★项目的 provider/model 抄「代码开发」阶段的。`WsProjectSchema` 允许空串,但空串意味着
    //  这个项目**没有编码代理** —— 之后在这个工作区跑 per-project 阶段时就是一条静默跑不动的路。
    //  模板里没有 develop 阶段(自定义工作流)时才落到空串,那时本来也没有「开发」这回事。
    projects: a.projects.map((p) => ({
      repoId: p.repoId,
      branch: p.branch,
      provider: dev?.provider ?? '',
      model: dev?.model ?? '',
    })),
  }
}

/**
 * 项目搜索。**长清单是常态不是边界情况** —— 这个仓库的用户手里三四十个项目,
 * 一屏放得下五六个,不给搜索就等于让人用手指滚。
 *
 * 按 名字 / 别名 / 仓库地址 匹配,大小写不敏感(照抄桌面向导的匹配面,少一个都会让人
 * 「我明明记得有这个项目」)。空查询 = 全部,不做任何过滤。
 */
export function filterProjects<T extends { name: string; alias?: string; repoUrl?: string }>(
  list: T[],
  query: string,
): T[] {
  const q = (query ?? '').trim().toLowerCase()
  // 空查询**原样返回同一个数组引用**(不是一份等值的拷贝)。`includes('')` 恒真,所以走下面
  // 那条也能出对的内容 —— 但每敲一下键盘就重建一次几十条的数组,而 RN 的列表是按引用比的。
  if (!q) return list
  return list.filter((p) =>
    [p.name, p.alias ?? '', p.repoUrl ?? ''].some((f) => f.toLowerCase().includes(q)),
  )
}

/**
 * 一个工作流在列表里显示的那行副标题:阶段名,按顺序。
 * 提示词、provider 配置一个字都不显示 —— 设计文档 §10 开放问题 5 的结论。
 */
export function stageLabels(wf: WorkflowTemplate, stageDefs: StageDefById): string[] {
  return resolveStages(wf.stages, stageDefs).map((s) => stageDisplayName(s))
}

/**
 * 阶段显示名:自己带的 `name` 优先,内置 key 回退中文名,最后回退 key 本身。
 * ★这张表是 `src/main/config/schema.ts` 的 `STAGE_NAMES` 的副本 —— 那边 import zod,
 *  手机端拉不动。桌面端的 `WorkflowPane.tsx` 也是同样抄了一份(见它第 17 行的注释)。
 */
const BUILTIN_STAGE_NAMES: Record<string, string> = {
  requirement: '需求评估',
  design: '技术方案设计',
  develop: '代码开发',
  test: '写单测',
  review: '代码 CR',
}

export function stageDisplayName(s: { key: string; name?: string }): string {
  const own = (s.name ?? '').trim()
  return own || BUILTIN_STAGE_NAMES[s.key] || s.key
}
