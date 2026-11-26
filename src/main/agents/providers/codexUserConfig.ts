import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appLog } from '../../log/appLog'

/**
 * ★R6:app-server 也不吃用户 ~/.codex/config.toml 里的那些定制 —— 和 exec 那条路的 `--ignore-user-config` 对齐。
 *  用户机器上的 oh-my-codex 装了 notify、
 *  开发者指令和一串 omx_* MCP 服务;exec 上它们把回复卡住过,所以 exec 一直带 --ignore-user-config。
 *  `codex app-server` 没有这个开关(0.154 实测),只能用 `-c` 覆盖逐项关掉。
 *
 * ★★codex 的 `-c` 是**深合并**到用户配置上的(0.154 实测 `codex -c 'mcp_servers={}' mcp list`:用户的服务全在),
 *  整表清空做不到,只能对用户配置里的每个 MCP 服务单独 `enabled=false`。forge 不关(我们自己的,随后由
 *  forgeCodexConfigArgs 覆盖)。名字里带点 / 空格的服务 `-c` 的点路径寻址不到、根上整张内联表列不出名字:只能跳过,记一条日志(R9)。
 *
 * ★★R7:钩子**不关**(2026-10-26 用户定,见 codexAppServer.ts 文件头):用户的钩子里有必须照常运行的
 *  (上报、审计一类),会截走审批的那条用户已经自己从 hooks.json 里去掉了。这里绝不带 features.(codex_)hooks 覆盖。
 * 插件:用户配置里 `[plugins."…"] enabled=true` 带进来的 MCP / 钩子,exec 忽略配置时也没有。
 *
 * 仍然和 exec 不同的(覆盖做不到「撤销」一个键):model / model_reasoning_effort / service_tier /
 * profile / model_provider / [features] 其余开关 / [agents] / [env] / shell_environment_policy / projects 信任
 * 照用户配置生效。
 */
export function codexAppServerIsolationArgs(env: NodeJS.ProcessEnv): string[] {
  const args = [
    '-c', 'notify=[]',
    '-c', 'features.plugins=false',
    '-c', 'developer_instructions=""',
  ]
  let toml = ''
  try { toml = readFileSync(join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8') } catch { /* 没有用户配置 */ }
  const skipped: string[] = []
  for (const name of userMcpServerNames(toml)) {
    if (name === 'forge') continue
    if (!BARE_KEY.test(name)) { skipped.push(`"${name}"`); continue }
    args.push('-c', `mcp_servers.${name}.enabled=false`)
  }
  // ★R9:关不掉的就留个痕(只进日志,不上界面),同样的内容只记一次 —— 每一轮都会走到这里。
  const why: string[] = []
  if (skipped.length) why.push(`名字不是 -c 写得出的裸键:${skipped.join(', ')}`)
  if (hasRootInlineTable(toml)) why.push('根上的 mcp_servers = { … } 内联表列不出服务名')
  if (why.length) {
    const msg = `app-server 关不掉用户 config.toml 里的部分 MCP 服务(这些会照常加载):${why.join(';')}`
    if (!logged.has(msg)) { logged.add(msg); appLog('warn', 'codex', msg) }
  }
  return args
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/
const logged = new Set<string>()

/** 根上(第一个表头之前)用一整张内联表写的 `mcp_servers = { … }`。 */
function hasRootInlineTable(toml: string): boolean {
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) return false
    if (/^mcp_servers\s*=/.test(line)) return true
  }
  return false
}

/** 用户 config.toml 里登记的 MCP 服务名(`[mcp_servers.x]` / `[mcp_servers."x"]` 表头、`[mcp_servers]` 下的 `x = {…}`、根上的 `mcp_servers.x.… =`)。 */
export function userMcpServerNames(toml: string): string[] {
  const names: string[] = []
  const add = (n: string) => { if (n && !names.includes(n)) names.push(n) }
  let inTable = false
  let atRoot = true
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    // 根上的点键:mcp_servers.x.command = …
    if (atRoot && !line.startsWith('[')) {
      const m = /^mcp_servers\s*\.\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*[.=]/.exec(line)
      if (m) add(m[1] ?? m[2] ?? m[3])
      continue
    }
    if (line.startsWith('[')) {
      atRoot = false
      inTable = /^\[\s*mcp_servers\s*\]$/.test(line)
      const m = /^\[\s*mcp_servers\s*\.\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))/.exec(line)
      if (m) add(m[1] ?? m[2] ?? m[3])
      continue
    }
    if (inTable) {
      const m = /^(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:=|\.)/.exec(line)
      if (m) add(m[1] ?? m[2] ?? m[3])
    }
  }
  return names
}
