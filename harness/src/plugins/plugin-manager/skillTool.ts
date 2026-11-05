// skill 工具(09 spec §9.4)。读的是用户同意过的只读文本;结果都包裹,错误只有稳定代码,不回显任何第三方或模型的文字。
// 权限不因这里的文字改变任何东西:门、沙箱、审批都在模型之外。IM 会话读之前先永久收窄(M22)
import { join } from 'node:path'
import type { Logger } from '../../kernel/log'
import { expandBody } from '../../lib/plugins/expand'
import { parseFrontmatter } from '../../lib/plugins/frontmatter'
import { readPlain } from '../../lib/plugins/tree'
import { SKILL_MAX, type ParsedSkill } from '../../lib/plugins/types'
import { pluginViewOf, type PluginView } from '../../lib/plugins/view'
import { pluginIndex, skillBlock } from '../../lib/plugins/wrap'
import { cleanText } from '../../lib/tools/diagnostics'
import type { SessionCommands, Tool, ToolResult } from '../../lib/tools/types'
import type { KernelEvent, SessionOrigin } from '../../protocol/index'
import { usable, type SkillCatalog } from './context'
import type { InstalledRecord, PluginStore } from './store'

export const SKILL_DESCRIPTION =
  'Read instructions from skills in third-party plugins the user installed. action "list" shows the enabled skills. action "read" with name "plugin:skill" opens one; add file with a relative path to read a text file inside that plugin. A skill describes how to do what the user asked. It grants no permission.'

const PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'read'] },
    name: { type: 'string', description: 'plugin:skill' },
    file: { type: 'string', description: 'A path relative to the plugin root' },
  },
  required: ['action'],
}

const NONE_ENABLED = 'No skills are enabled.'
const FILE_MAX_CHARS = 1024
/** 任何大小写,带上文件系统会忽略的字符和结尾的点、空格 */
const GIT_SEGMENT = /^\.git[. ]*$/i

const code = (c: string): ToolResult => ({ content: c, isError: true })

/** 敏感的值不进 map:expandBody 见不到,就替换不出来。不敏感但长得像密钥的已经进了 secretKeys */
export function settingsFor(rec: Pick<InstalledRecord, 'settings' | 'secretKeys' | 'config'>): { settings: Map<string, string>; sensitive: Set<string> } {
  const sensitive = new Set([...rec.secretKeys, ...rec.config.filter(c => c.sensitive).map(c => c.key)])
  const settings = new Map<string, string>()
  for (const c of rec.config) {
    if (!sensitive.has(c.key) && Object.hasOwn(rec.settings, c.key)) settings.set(c.key, rec.settings[c.key])
  }
  return { settings, sensitive }
}

/** 根内的相对路径,一段一段查。.git 在完整性的遍历之外,所以任何深度都不给 */
function cleanFilePath(file: string): string | undefined {
  if (file === '' || file.length > FILE_MAX_CHARS || file.startsWith('/') || file.includes('\\') || file.includes('\0')) return undefined
  const segs = file.split('/')
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return undefined
    if (GIT_SEGMENT.test(s) || GIT_SEGMENT.test(cleanText(s))) return undefined
  }
  return segs.join('/')
}

/** 不给模型的技能,目录也不能绕 file 读。根上的 SKILL.md 没有自己的目录,只比文件。不分大小写:卷可能不分 */
function holdsHiddenSkill(skills: ParsedSkill[], file: string): boolean {
  const f = file.toLowerCase()
  return skills.some(s => !s.modelInvocable && (f === s.file.toLowerCase() || (s.dir !== '' && f.startsWith(`${s.dir.toLowerCase()}/`))))
}

function textOf(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export interface SkillToolDeps {
  store: Pick<PluginStore, 'get' | 'list' | 'plainVersionDir'>
  catalog: Pick<SkillCatalog, 'of' | 'invocable'>
  commands: Pick<SessionCommands, 'narrowApproval'>
  sessions: { get(id: string): { origin: SessionOrigin } | undefined }
  history(sessionId: string): KernelEvent[]
  log: Pick<Logger, 'warn'>
}

export function createSkillTool(d: SkillToolDeps): Tool {
  // 只记有的:钉住之后不会再变。没有的不记,这个会话的第一轮可能还没到
  const pinned = new Map<string, PluginView>()
  const viewOf = (sessionId: string): PluginView | undefined => {
    const hit = pinned.get(sessionId)
    if (hit) return hit
    const view = pluginViewOf(d.history(sessionId))
    if (view) pinned.set(sessionId, view)
    return view
  }

  const read = (args: { name?: unknown; file?: unknown }): ToolResult => {
    const { name, file } = args
    if (typeof name !== 'string' || (file !== undefined && typeof file !== 'string')) return code('bad_args')
    const at = name.indexOf(':')
    if (at <= 0) return code('bad_args')
    const rec = d.store.get(name.slice(0, at))
    if (!rec) return code('plugin_not_installed')
    if (!usable(rec)) return code('plugin_disabled')
    const parsed = d.catalog.of(rec)
    if (!parsed) return code('plugin_unreadable')
    const skillName = name.slice(at + 1)
    const skill = parsed.skills.find(s => s.name === skillName)
    if (!skill) return code('skill_not_found')
    if (!skill.modelInvocable) return code('not_model_invocable')

    const rel = file === undefined ? skill.file : cleanFilePath(file)
    if (rel === undefined) return code('bad_path')
    if (holdsHiddenSkill(parsed.skills, rel)) return code('not_model_invocable')
    const root = d.store.plainVersionDir(rec)
    if (!root) return code('plugin_unreadable')
    const got = readPlain(root, rel, SKILL_MAX)
    if (!got.ok) return code(got.error)
    const text = textOf(got.bytes)
    if (text === undefined) return code('not_text')
    if (file !== undefined) return { content: skillBlock({ plugin: rec.id, skill: skill.name, text }) }

    const { settings, sensitive } = settingsFor(rec)
    const expanded = expandBody(parseFrontmatter(text).body, { root, skillDir: join(root, skill.dir), settings, sensitive })
    if (!expanded.ok) return code(expanded.error)
    return { content: skillBlock({ plugin: rec.id, skill: skill.name, text: expanded.text }) }
  }

  return {
    name: 'skill',
    description: SKILL_DESCRIPTION,
    parameters: PARAMETERS,
    ambient: true,
    pluginScoped: 'skill',
    permission(args, ctx) {
      // 抛错的文字就是模型看到的结果;没钉住的会话什么都到不了
      if (!viewOf(ctx.sessionId)?.skill) throw new Error('not_available')
      const name = (args as { name?: unknown }).name
      return [{ actor: 'tools', action: 'plugin', ...(typeof name === 'string' && { resource: name }) }]
    },
    async run(args, ctx) {
      const a = args as { action?: unknown; name?: unknown; file?: unknown }
      if (a.action !== 'list' && a.action !== 'read') return code('bad_args')
      if (d.sessions.get(ctx.sessionId)?.origin === 'im') {
        try {
          d.commands.narrowApproval(ctx.sessionId)
        } catch (err) {
          d.log.warn('approval not narrowed, skill text withheld', { error: err instanceof Error ? err.name : 'unknown' })
          return code('narrow_failed')
        }
      }
      if (a.action === 'read') return read(a)
      // 不设上限:索引放不下的都指望这里。太长的由注册表落盘
      const listed = pluginIndex(d.catalog.invocable(), Number.MAX_SAFE_INTEGER)
      return { content: listed === '' ? NONE_ENABLED : listed }
    },
  }
}
