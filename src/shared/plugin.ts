export interface PluginCatalogItem { id: string; name: string }
export const HOOK_SKILLS: PluginCatalogItem[] = [
  { id: 'systematic-debugging', name: 'systematic-debugging' },
  { id: 'writing-plans', name: 'writing-plans' },
  { id: 'test-driven-development', name: 'test-driven-development' },
  { id: 'code-review', name: 'code-review' },
  { id: 'ai-slop-cleaner', name: 'ai-slop-cleaner' },
  { id: 'analyze', name: 'analyze' },
]
export const HOOK_TOOLS: PluginCatalogItem[] = [
  { id: 'read', name: '读取文件' }, { id: 'edit', name: '编辑文件' }, { id: 'bash', name: '终端命令' },
  { id: 'grep', name: '代码搜索' }, { id: 'git', name: 'Git 操作' }, { id: 'web', name: '联网搜索' }, { id: 'mcp', name: 'MCP 调用' },
]
export interface Plugin { id: string; name: string; prompt: string; after: string; skills: string[]; tools: string[] }
// Reusable, slot-agnostic hook stored in the global library (设置 → Hook 库). = Plugin without `after`;
// the slot is assigned when a copy is inserted into a workspace at create time. Renderer-side mirror of
// LibraryHookSchema in src/main/config/schema.ts (kept structurally identical via a parity guard there).
export interface LibraryHook { id: string; name: string; prompt: string; skills: string[]; tools: string[] }
