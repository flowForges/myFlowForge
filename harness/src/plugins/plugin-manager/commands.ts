// 插件命令(09 spec §9.5)。展开成带标记的提示,作为外部消息进用户指定的会话:
// 第三方文字不是用户原话,所以不进记忆提取的证据;用户打的参数也一样(§17 Ruling)。
// 不看视图、不碰权限:`allowed-tools`、`!`…`` 已经在读的时候被忽略,正文里的都只是文字
import { join } from 'node:path'
import type { Logger } from '../../kernel/log'
import { expandSealed } from '../../lib/plugins/expand'
import { parseFrontmatter } from '../../lib/plugins/frontmatter'
import { readPlain } from '../../lib/plugins/tree'
import { COMMAND_MAX, SKILL_MAX } from '../../lib/plugins/types'
import { commandBlock } from '../../lib/plugins/wrap'
import type { SessionCommands } from '../../lib/tools/types'
import type { SessionOrigin, WorkerResult } from '../../protocol/index'
import { usable, type SkillCatalog } from './context'
import { fail } from './installer'
import { settingsFor, textOf } from './skillTool'
import type { PluginStore } from './store'

export const ARGS_MAX = 8000

export interface CommandsDeps {
  store: Pick<PluginStore, 'get' | 'list' | 'plainVersionDir'>
  catalog: Pick<SkillCatalog, 'of'>
  commands: Pick<SessionCommands, 'call' | 'narrowApproval'>
  sessions: { get(id: string): { origin: SessionOrigin } | undefined }
  log: Pick<Logger, 'warn'>
}

export interface CommandItem {
  name: string
  plugin: string
  description: string
  argumentHint?: string
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 启用的插件的命令,加上 `user-invocable` 不为 false 的技能。同名时命令优先 */
export function listCommands(d: Pick<CommandsDeps, 'store' | 'catalog'>): CommandItem[] {
  const out = new Map<string, CommandItem>()
  for (const rec of d.store.list().filter(usable)) {
    const parsed = d.catalog.of(rec)
    if (!parsed) continue
    const item = (name: string, description: string, argumentHint?: string): [string, CommandItem] => [`${rec.id}:${name}`, { name: `${rec.id}:${name}`, plugin: rec.id, description, ...(argumentHint && { argumentHint }) }]
    for (const s of parsed.skills) if (s.userInvocable) out.set(...item(s.name, s.description, s.argumentHint))
    for (const c of parsed.commands) out.set(...item(c.name, c.description, c.argumentHint))
  }
  return [...out.values()].sort((a, b) => cmp(a.name, b.name))
}

export async function runCommand(p: { commandId: string; sessionId: string; name: string; args: string }, d: CommandsDeps): Promise<WorkerResult<'session.prompt'>> {
  // 内层 id 是 `<id>/prompt`:客户端自己用这个形状的 id 发过提示,命令会被回执悄悄吞掉
  if (p.commandId.endsWith('/prompt')) throw fail('bad_args')
  if (typeof p.args !== 'string' || p.args.length > ARGS_MAX) throw fail('too_large')
  const at = p.name.indexOf(':')
  if (at <= 0 || at === p.name.length - 1) throw fail('bad_args')
  if (!d.sessions.get(p.sessionId)) throw fail('unknown session')
  const rec = d.store.get(p.name.slice(0, at))
  if (!rec) throw fail('plugin_not_installed')
  if (!usable(rec)) throw fail('plugin_disabled')
  const parsed = d.catalog.of(rec)
  if (!parsed) throw fail('plugin_unreadable')
  const name = p.name.slice(at + 1)
  const root = d.store.plainVersionDir(rec)
  if (!root) throw fail('plugin_unreadable')

  let body: string
  let argNames: string[]
  let skillDir: string | undefined
  const cmd = parsed.commands.find(c => c.name === name)
  if (cmd) {
    if (cmd.tooLarge) throw fail('too_large')
    body = cmd.body
    argNames = cmd.argNames
  } else {
    const skill = parsed.skills.find(s => s.name === name && s.userInvocable)
    if (!skill) throw fail('command_not_found')
    if (skill.tooLarge) throw fail('too_large')
    const got = readPlain(root, skill.file, SKILL_MAX)
    if (!got.ok) throw fail(got.error)
    // 命令的上限是 64 KB:更大的不发一条被截断的提示
    if (got.bytes.length > COMMAND_MAX) throw fail('too_large')
    const text = textOf(got.bytes)
    if (text === undefined) throw fail('not_text')
    body = parseFrontmatter(text).body
    argNames = skill.argNames
    skillDir = join(root, skill.dir)
  }

  const { settings, sensitive } = settingsFor(rec)
  const expanded = expandSealed(body, { root, ...(skillDir !== undefined && { skillDir }), settings, sensitive, args: p.args, argNames })
  if (!expanded.ok) throw fail(expanded.error)
  const text = commandBlock({ plugin: rec.id, command: name, text: expanded.text, seal: expanded.seal })

  // 远程会话:第三方文字进去之前。会话正忙时先收窄、再回 ERR_BUSY:安全的方向,不撤回。,auto 先收回成 ask。收不回来就不发(M22)
  if (d.sessions.get(p.sessionId)?.origin === 'im') {
    try {
      d.commands.narrowApproval(p.sessionId)
    } catch (err) {
      d.log.warn('approval not narrowed, command not sent', { error: err instanceof Error ? err.name : 'unknown' })
      throw fail('narrow_failed')
    }
  }
  // 内层用派生的 id:外层自己占着 commandId 的回执,同一个 id 会让重放报错(M7)
  return d.commands.call('session.prompt', { commandId: `${p.commandId}/prompt`, sessionId: p.sessionId, text, external: true })
}
