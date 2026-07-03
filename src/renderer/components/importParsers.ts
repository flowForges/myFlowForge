// Pure parsers + copyable samples for the batch-import sheets. Each parser throws on invalid input
// (the modal disables Import on throw). Shared by projects / plugins / pet.

const stripComments = (text: string) => text.replace(/^\s*\/\/.*$/gm, '').trim()

// ---------- Projects ----------
export interface ParsedProject { repo: string; branch: string }

export const PROJ_SAMPLE = [
  '[',
  '  { "repo": "git@github.com:acme/web-app.git", "branch": "main" },',
  '  { "repo": "git@github.com:acme/api-server.git", "branch": "develop" },',
  '  { "repo": "https://github.com/acme/design-tokens.git", "branch": "feat/v3" },',
  '  { "repo": "/Users/me/code/internal-cli", "branch": "main" }',
  ']',
  '',
  '// 也支持每行一条(去掉上面的 JSON,改写成):',
  '// git@github.com:acme/web-app.git, main',
  '// /Users/me/code/internal-cli  develop',
].join('\n')

export function parseProjects(text: string): ParsedProject[] {
  const out: ParsedProject[] = []
  const t = stripComments(text)
  if (!t) return out
  if (t[0] === '[' || t[0] === '{') {
    let data = JSON.parse(t)
    if (!Array.isArray(data)) data = [data]
    for (const o of data) {
      const repo = String(o?.repo || o?.url || o?.git || '').trim()
      if (repo) out.push({ repo, branch: String(o?.branch || o?.ref || 'main').trim() || 'main' })
    }
  } else {
    for (const raw of t.split(/\r?\n/)) {
      const ln = raw.trim()
      if (!ln || ln[0] === '#') continue
      const parts = ln.split(/\s*,\s*|\s+/)
      const repo = (parts[0] || '').trim()
      if (repo) out.push({ repo, branch: (parts[1] || 'main').trim() || 'main' })
    }
  }
  return out
}

// ---------- Plugins ----------
export interface ParsedPlugin { name: string; prompt: string; after: string; skills: string[]; tools: string[] }

const VALID_AFTER = new Set(['__start', 'requirement', 'design', 'develop', 'test', 'review'])
const VALID_SKILLS = new Set(['systematic-debugging', 'writing-plans', 'test-driven-development', 'code-review', 'ai-slop-cleaner', 'analyze'])
const VALID_TOOLS = new Set(['read', 'edit', 'bash', 'grep', 'git', 'web', 'mcp'])
// Friendly alias: the prototype/older docs used "assess" for the requirement stage.
const AFTER_ALIAS: Record<string, string> = { assess: 'requirement' }

export const PLUGIN_SAMPLE = [
  '[',
  '  {',
  '    "name": "当前时间",',
  '    "prompt": "输出当前时间戳(本地时区),供后续阶段引用为 {{now}}。",',
  '    "after": "requirement",',
  '    "skills": [],',
  '    "tools": ["bash"]',
  '  },',
  '  {',
  '    "name": "读取我的记忆",',
  '    "prompt": "读取项目记忆与历史偏好,整理成要点注入后续上下文,引用为 {{memory}}。",',
  '    "after": "design",',
  '    "skills": ["analyze"],',
  '    "tools": ["read", "grep"]',
  '  }',
  ']',
  '',
  '// after 可填:__start / requirement / design / develop / test / review',
  '// skills 可填:systematic-debugging / writing-plans / test-driven-development / code-review / ai-slop-cleaner / analyze',
  '// tools  可填:read / edit / bash / grep / git / web / mcp',
].join('\n')

export function parsePlugins(text: string): ParsedPlugin[] {
  const t = stripComments(text)
  let data = JSON.parse(t)
  if (!Array.isArray(data)) data = [data]
  const out: ParsedPlugin[] = []
  for (const o of data) {
    const name = String(o?.name || '').trim()
    if (!name) continue
    const afterRaw = String(o?.after || '__start')
    const after = VALID_AFTER.has(afterRaw) ? afterRaw : (AFTER_ALIAS[afterRaw] ?? '__start')
    const skills = Array.isArray(o?.skills) ? o.skills.filter((s: unknown) => VALID_SKILLS.has(String(s))) : []
    const tools = Array.isArray(o?.tools) ? o.tools.filter((s: unknown) => VALID_TOOLS.has(String(s))) : []
    out.push({ name, prompt: String(o?.prompt || ''), after, skills, tools })
  }
  if (!out.length) throw new Error('每个插件至少需要一个 name')
  return out
}

// ---------- Pet ----------
export interface ParsedPet { name: string; emoji: string; color: string }

export const PET_SAMPLE = [
  '{',
  '  "name": "豆豆",',
  '  "emoji": "🐱",',
  '  "color": "oklch(72% .16 30)"',
  '}',
  '',
  '// name = 形象名称;emoji = 用作宠物的表情符号;',
  '// color = 主题色(oklch / hex 均可),用于卡片与高亮。',
].join('\n')

export function parsePet(text: string): ParsedPet[] {
  const d = JSON.parse(stripComments(text))
  // Accept either a single pet object or an array of them (batch-add multiple custom pets at once).
  const arr = Array.isArray(d) ? d : [d]
  const out = arr.map((one, i): ParsedPet => {
    const name = String(one?.name || '').trim()
    const emoji = String(one?.emoji || '').trim()
    if (!name) throw new Error(arr.length > 1 ? `第 ${i + 1} 项缺少 name 字段` : '需要一个 name 字段')
    if (!emoji) throw new Error(arr.length > 1 ? `第 ${i + 1} 项缺少 emoji 字段` : '需要一个 emoji 字段(用作宠物形象)')
    return { name, emoji, color: String(one?.color || '').trim() }
  })
  if (!out.length) throw new Error('需要至少一个形象定义')
  return out
}
