import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexAppServerIsolationArgs, userMcpServerNames } from './codexUserConfig'

// R6:exec 带 --ignore-user-config(oh-my-codex 的钩子 / notify 会把回复卡住);app-server 没有这个开关,
// 只能用 -c 覆盖把同样的东西关掉。★codex 的 -c 是**深合并**(实测 0.154:`-c mcp_servers={}` 清不掉用户的表),
// 所以用户的 MCP 只能逐个 enabled=false。
const USER_TOML = `
notify = ["node", "/x/notify-hook.js"]
developer_instructions = "You have oh-my-codex installed."
model = "gpt-5.6-sol"

[features]
codex_hooks = true

[mcp_servers.omx_state]
command = "node"
[mcp_servers.omx_memory]
command = "node"
[mcp_servers.omx_memory.tools.project_memory_add_directive]
approval_mode = "approve"
[mcp_servers."quoted-name"]
command = "x"
[mcp_servers.forge]
command = "old"
[mcp_servers."has.dot"]
command = "z"

[mcp_servers]
inline_one = { command = "y" }

[projects."/a"]
trust_level = "trusted"
`

describe('userMcpServerNames', () => {
  it('列出用户 config.toml 里所有的 MCP 服务名(表头 / 引号名 / [mcp_servers] 下的内联项),去重', () => {
    expect(userMcpServerNames(USER_TOML)).toEqual(['omx_state', 'omx_memory', 'quoted-name', 'forge', 'has.dot', 'inline_one'])
  })
  it('空文件 / 没有 MCP → []', () => {
    expect(userMcpServerNames('')).toEqual([])
    expect(userMcpServerNames('model = "x"\n[projects."/a"]\ntrust_level = "trusted"\n')).toEqual([])
  })
})

describe('codexAppServerIsolationArgs', () => {
  it('关 notify / 钩子 / 插件 / 用户的开发者指令,用户的 MCP 逐个 enabled=false(forge 除外)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-home-'))
    try {
      writeFileSync(join(dir, 'config.toml'), USER_TOML)
      expect(codexAppServerIsolationArgs({ CODEX_HOME: dir })).toEqual([
        '-c', 'notify=[]',
        '-c', 'features.hooks=false',
        '-c', 'features.codex_hooks=false',
        '-c', 'features.plugins=false',
        '-c', 'developer_instructions=""',
        '-c', 'mcp_servers.omx_state.enabled=false',
        '-c', 'mcp_servers.omx_memory.enabled=false',
        '-c', 'mcp_servers.quoted-name.enabled=false',
        '-c', 'mcp_servers.inline_one.enabled=false',
      ])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('名字里带点的服务 -c 寻址不到:跳过(不能生成一条错的路径)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-home-'))
    try {
      writeFileSync(join(dir, 'config.toml'), USER_TOML)
      expect(codexAppServerIsolationArgs({ CODEX_HOME: dir }).some(a => a.includes('has.dot'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('没有 config.toml:只有固定的那几条', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-home-'))
    try {
      expect(codexAppServerIsolationArgs({ CODEX_HOME: dir })).toEqual([
        '-c', 'notify=[]', '-c', 'features.hooks=false', '-c', 'features.codex_hooks=false', '-c', 'features.plugins=false', '-c', 'developer_instructions=""',
      ])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
