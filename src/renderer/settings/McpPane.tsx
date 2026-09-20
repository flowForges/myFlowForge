import { McpList } from '../components/McpPanel'

/**
 * 设置 → MCP。
 *
 * ★★这一页**顶掉了原来的「Skill」页**(2026-09-05)。用户当场指出来的:「加载项里好像有 skill,
 *  所以 skill 是不是多余?」—— 是。「加载项」扫的就是全局 skill / rule / MCP,那一页只是它的子集,
 *  还只能看不能动。腾出来的位置给 MCP:授权是**必须有个地方点**的动作,而 skill 是纯陈列。
 * ★正文和聊天里 `/mcp` 弹出来的是**同一个组件**(`McpList`),不是抄的第二份。
 */
export function McpPane() {
  return (
    <div className="set-group mcp-pane">
      <McpList />
    </div>
  )
}
