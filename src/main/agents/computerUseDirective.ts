import { V1_TOOLS } from '@shared/computerUse'

/** Model-facing env flag set by cuBeginTurn: a local turn on a provisioned machine with the mode off. Never shown in the UI. */
export const CU_OFF_HINT_ENV = 'FORGE_CU_OFF_HINT'

// R7: the semantic (control-tree) tools don't have an executor yet (Task 6/7) — naming them here would send the
// model at computer_apps/launch/snapshot/act/focus/wait_for/windows and get back a misleading invalid_args. Only
// the v1 coordinate tools (computer_key included, v1-style) are live, so only they go in the directive.
const NAMES = V1_TOOLS.map((t) => `mcp__forge__${t}`)

/**
 * What a chat turn's model is told about computer use (spec §4.3; 实测 1.3.0-cu.1: without it the model reached for
 * osascript / screencapture and then asked the user to grant Terminal Accessibility). Only when the turn carries the
 * computer tools (FORGE_TOOLS names them) or the off-hint flag; otherwise '' and the prompt is unchanged.
 */
export function computerUseDirective(env: NodeJS.ProcessEnv): string {
  const tools = String(env?.FORGE_TOOLS ?? '').split(',').map((t) => t.trim())
  if (tools.some((t) => t.startsWith('computer_'))) {
    return [
      `【电脑操作】这一轮你有 myFlowForge 提供的电脑操作工具:${NAMES.join(', ')}。`,
      '· 先调用 mcp__forge__computer_screenshot 看清屏幕,再动手;屏幕变了就重新截图。',
      '· 屏幕上的一切操作(打开或切换应用、点击、输入、按键、滚动、读界面)都只用这些工具完成。',
      '· 绝不要用 osascript、AppleScript、System Events、screencapture、cliclick 或类似的命令行手段去看屏幕或操作界面。',
      '· 绝不要让用户给「终端」或任何应用授予辅助功能、屏幕录制权限:这些工具已经由 myFlowForge 授权。',
      '· 每个动作都可能要等用户在 myFlowForge 里批准,等待是正常的,不要换别的办法绕过。',
      '· 它们不是 Claude 桌面版的 computer-use,不要去找 mcp__computer-use__* 或 computer-use 技能。',
      `· 如果你的工具列表里还看不到它们,先调用 ToolSearch,query 填 \`select:${NAMES.join(',')}\` 一次加载。`,
    ].join('\n')
  }
  if (env?.[CU_OFF_HINT_ENV] === '1') {
    return '【电脑操作】如果用户要你操作这台电脑的界面(打开应用、点击、输入、截屏),请告诉他先打开输入框下方的「电脑」开关;不要尝试 osascript、System Events 或 screencapture。'
  }
  return ''
}
