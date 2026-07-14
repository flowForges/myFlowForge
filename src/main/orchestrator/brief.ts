import { stageBasePrompt, type ReviewLens } from '../config/schema'
import type { Plugin } from '../../shared/plugin'
import { skillDirective } from '../agents/pluginTools'

export interface HandoffBrief {
  agentName: string
  summary: string
  artifacts: { path: string; kind: string }[]
}

/**
 * 交互铁律 —— 注入每个子代理(阶段 agent + 插件 hook)提示词。子代理常常"自觉"不去问用户就
 * 硬跑或假设,codex 更是除 forge_ask 外没有任何交互通道。此段强制:凡需用户确认/二选一/补充输入,
 * 必须调 forge_ask 并阻塞等待,拿到答复前不得假设/跳过/编造。这是唯一被支持的向用户提问方式。
 */
export const INTERACTION_DIRECTIVE = [
  '【交互指令】执行过程中,凡是需要用户确认、在多个选项间二选一、或补充你无法自行决定的信息时,',
  '你【必须】调用 forge_ask 工具把问题(有选项时一并给出选项)发给用户并阻塞等待答复;',
  '在拿到用户答复前,严禁自行假设、跳过、或编造答案。这是唯一被支持的向用户提问的方式。',
  '(You MUST call the forge_ask tool and block for the user\'s answer whenever you need',
  ' confirmation, a choice, or input you cannot decide yourself; never assume, skip, or fabricate.)',
].join('\n')

const LENS_DIRECTIVE: Record<ReviewLens, string> = {
  correctness: '【审查视角】只聚焦正确性:逻辑错误、边界条件、空值/异常处理、契约一致性。',
  security: '【审查视角】只聚焦安全:注入、鉴权/越权、敏感信息泄露、不安全依赖。',
  performance: '【审查视角】只聚焦性能:复杂度、N+1、内存/资源占用、可避免的同步阻塞。',
  style: '【审查视角】只聚焦风格:命名、可读性、重复、与项目既有约定的一致性。',
}

/**
 * Authoritative directive prepended to EVERY stage sub-agent prompt.
 *
 * Stage sub-agents run with cwd at/under the workspace, where the `forge-workflow` skill lives.
 * claude auto-discovers that skill and (because its description matches "功能实现/开发") activates
 * it — which tells the agent to PROPOSE a plan and wait for approval instead of doing the work.
 * That made every stage agent "go on strike" and emit forge:run / forge_propose_plan instead of
 * implementing. This directive overrides the skill: the workflow is already approved and running,
 * so the stage agent must execute its real work NOW.
 */
function executeNowDirective(stageName: string, producesDoc: boolean): string {
  const designDirective = producesDoc
    ? [
      '- 你【必须】把完整技术方案写成一个 Markdown 文件落到磁盘，不能只在回复里给方案：',
      '  · 路径不写死——若仓库已有文档/规范目录（如 docs/、doc/、spec/、specs/、.spec 等）就写进该目录，否则直接放工作区/项目根目录；文件名形如 `技术方案-<项目名>.md`；',
      '  · 用规范 Markdown（标题、列表、表格用标准 GFM 语法，不要手动折行把表格行拆散）；',
      '  · 写完【必须】通过 forge_handoff 的 artifacts 上报该文件相对路径（形如 `{ "path": "docs/技术方案-xxx.md", "kind": "md" }`），summary 为一句话方案摘要；无 MCP 工具时用 forge:handoff 围栏上报同样的 artifacts。',
      '- 技术方案设计汇总代理 → 读取所有项目子方案交接，输出统一总技术方案，同样【必须】写成一个 Markdown 文件（放工作区根目录，如 `技术方案-总览.md`）并通过 artifacts 上报其路径；说明跨项目接口、依赖顺序、风险和验证策略。',
    ]
    : []
  return [
    `【执行指令】你是 Forge 工作流中被指派执行「${stageName}」阶段的子代理。该工作流已经过用户批准、正在运行中。请立即执行本阶段的实际工作：`,
    '- 需求/设计阶段 → 产出文档/方案文件并写入工作区；',
    '- 开发阶段 → 直接读写项目代码实现功能；',
    '- 测试/评审阶段 → 写测试/做评审并落文件。',
    ...designDirective,
    '不要提出方案等待批准，不要调用 forge_propose_plan，不要输出 forge:run 围栏块，不要把本阶段当成"规划"——那只属于交互式主代理。现在就动手完成本阶段。',
  ].join('\n')
}

export function buildStagePrompt(
  stageName: string,
  briefs: HandoffBrief[],
  opts: { textFallback: boolean; task?: string; lens?: ReviewLens; stageKey?: string; stageAppend?: string; reworkNote?: string; producesDoc?: boolean; brief?: string },
): string {
  let result = opts.task ? `任务: ${opts.task}\n\n当前阶段: ${stageName}` : stageName
  // 主代理整理的需求级简报(背景/目标/约束/指定插件),置于最前作为执行上下文——修"工作流不带上下文"。
  const brief = (opts.brief ?? '').trim()
  if (brief) result = `【需求简报 — 主代理整理的背景与要求】\n${brief}\n\n` + result

  // 返工:用户审阅上一版后「打回重做」并给出的修改方向。以最高优先级明确要求重做整改,而不是复述。
  const rework = (opts.reworkNote ?? '').trim()
  if (rework) {
    result += '\n\n【返工要求 — 最高优先级】用户审阅了你上一版的产出后要求返工。请严格针对下面的修改方向,' +
      '重新完成本阶段(该重新探查的重新探查、该重整方案的重整方案、该改代码的改代码),给出一版新的成果,' +
      '不要简单复述上一版:\n' + rework
  }

  // 内置阶段有恒定基座正文(用户改不了),此时 stageAppend 是追加段;自定义阶段无基座,stageAppend 即完整正文。
  const base = opts.stageKey ? stageBasePrompt(opts.stageKey) : undefined
  const append = (opts.stageAppend ?? '').trim()
  if (base) {
    result += '\n' + base
    if (append) result += '\n\n【附加要求】以下是用户对本阶段的额外要求,在不违反上述执行纪律的前提下一并满足:\n' + append
  } else if (append) {
    // 自定义阶段:用户写的 prompt 就是本阶段的完整正文。
    result += '\n\n' + append
  }

  if (opts.lens) result += '\n\n' + LENS_DIRECTIVE[opts.lens]

  if (briefs.length > 0) {
    const lines = briefs.map(b => {
      let line = `- [${b.agentName}] ${b.summary}`
      if (b.artifacts.length > 0) {
        line += `（产物: ${b.artifacts.map(a => a.path).join(', ')}）`
      }
      return line
    })
    result += '\n\n上游交接:\n' + lines.join('\n')
  }

  if (opts.textFallback) {
    result += '\n\n如需向编排器交接成果，请在输出中包含如下围栏块（把 ... 替换为真实值，summary 为一句话成果摘要、artifacts 为产物相对路径）：\n```forge:handoff\n{ "summary": ..., "artifacts": [ { "path": ..., "kind": "md" } ] }\n```'
  }

  return executeNowDirective(stageName, opts.producesDoc ?? false) + '\n\n' + INTERACTION_DIRECTIVE + '\n\n' + result
}

/**
 * Build the prompt for a workflow-scope plugin (hook micro-agent). The hook runs as a single
 * restricted sub-agent in the workspace root. Header = the requested skill directive (empty when
 * the plugin has no skills, so there's no directive noise); then the user task, the plugin step
 * name, the accumulated upstream briefs (so the hook can react to earlier stage/hook output), and
 * finally the plugin's own prompt.
 */
export function buildPluginPrompt(plugin: Plugin, briefs: HandoffBrief[], task?: string): string {
  const parts: string[] = []
  const dir = skillDirective(plugin.skills)
  if (dir) parts.push(dir.trim())
  parts.push(INTERACTION_DIRECTIVE)
  if (task) parts.push(`任务: ${task}`)
  parts.push(`插件步骤: ${plugin.name}`)
  if (briefs.length) {
    parts.push('上游产出:')
    for (const b of briefs) parts.push(`- [${b.agentName}] ${b.summary}` + (b.artifacts.length ? `（产物: ${b.artifacts.map(a => a.path).join(', ')}）` : ''))
  }
  parts.push('', plugin.prompt || '（无具体 prompt，作为占位步骤，简要说明已就绪即可。）')
  return parts.join('\n')
}
