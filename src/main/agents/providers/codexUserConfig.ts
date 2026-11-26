import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * ★R6:app-server 也不吃用户 ~/.codex/config.toml 里的那些定制 —— 和 exec 那条路的 `--ignore-user-config` 对齐。
 *  用户机器上的 oh-my-codex 装了 notify、钩子(~/.codex/hooks.json,含会截走审批的 PermissionRequest)、
 *  开发者指令和一串 omx_* MCP 服务;exec 上它们把回复卡住过,所以 exec 一直带 --ignore-user-config。
 *  `codex app-server` 没有这个开关(0.154 实测),只能用 `-c` 覆盖逐项关掉。
 *
 * ★★codex 的 `-c` 是**深合并**到用户配置上的(0.154 实测 `codex -c 'mcp_servers={}' mcp list`:用户的服务全在),
 *  整表清空做不到,只能对用户配置里的每个 MCP 服务单独 `enabled=false`。forge 不关(我们自己的,随后由
 *  forgeCodexConfigArgs 覆盖)。名字里带点的服务 `-c` 的点路径寻址不到,只能跳过。
 *
 * 钩子:`features.hooks` 是 0.154 的名字,`features.codex_hooks` 是老名字(用户配置里写的就是它)——两条都给;
 *  `-c` 对不认识的键是忽略的(不像 `--disable <未知>` 会直接报错起不来)。
 * 插件:用户配置里 `[plugins."…"] enabled=true` 带进来的 MCP / 钩子,exec 忽略配置时也没有。
 *
 * 仍然和 exec 不同的(覆盖做不到「撤销」一个键):model / model_reasoning_effort / service_tier /
 * profile / model_provider / [features] 其余开关 / [agents] / [env] / shell_environment_policy / projects 信任
 * 照用户配置生效。
 */
export function codexAppServerIsolationArgs(env: NodeJS.ProcessEnv): string[] {
  const args = [
    '-c', 'notify=[]',
    '-c', 'features.hooks=false',
    '-c', 'features.codex_hooks=false',
    '-c', 'features.plugins=false',
    '-c', 'developer_instructions=""',
  ]
  let toml = ''
  try { toml = readFileSync(join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8') } catch { /* 没有用户配置 */ }
  for (const name of userMcpServerNames(toml)) {
    if (name === 'forge' || !/^[A-Za-z0-9_-]+$/.test(name)) continue
    args.push('-c', `mcp_servers.${name}.enabled=false`)
  }
  return args
}

/** 用户 config.toml 里登记的 MCP 服务名(`[mcp_servers.x]` / `[mcp_servers."x"]` 表头、`[mcp_servers]` 下的 `x = {…}`)。 */
export function userMcpServerNames(toml: string): string[] {
  const names: string[] = []
  const add = (n: string) => { if (n && !names.includes(n)) names.push(n) }
  let inTable = false
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
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
