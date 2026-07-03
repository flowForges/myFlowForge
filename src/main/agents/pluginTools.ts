// chip id → claude 工具名。git 经 Bash 执行;web 用 WebSearch/WebFetch;grep 含 Glob。
const CLAUDE_TOOL_MAP: Record<string, string[]> = {
  read: ['Read'], edit: ['Edit'], bash: ['Bash'], grep: ['Grep', 'Glob'],
  git: ['Bash'], web: ['WebSearch', 'WebFetch'], mcp: ['mcp__forge__*'],
}

export function claudeAllowedTools(toolIds: string[]): string[] {
  const out: string[] = []
  for (const id of toolIds) for (const t of (CLAUDE_TOOL_MAP[id] ?? [])) if (!out.includes(t)) out.push(t)
  return out
}

export function skillDirective(skillIds: string[]): string {
  if (!skillIds.length) return ''
  return `本步骤请加载并严格遵循以下技能(skill): ${skillIds.join(', ')}。\n\n`
}
