import { describe, it, expect } from 'vitest'
import { cutToJson, parsePluginHelp, parsePluginList, PluginMarket, type PluginDeps } from './pluginMarket'

/**
 * 样本全部来自 2026-09-05 在真机上跑的 `claude plugin` / `codex plugin`。
 * ★两个 CLI 的**动词不一样**(install/add、uninstall/remove),字段也不一样
 *  (claude 有 description + installCount,codex 有 version + installed)——
 *  这两处不对齐就是「点了安装报 unknown command」和「装过的显示成没装」。
 */

const CLAUDE_HELP = `Usage: claude plugin [options] [command]

Commands:
  init|new [options] <name>            Scaffold a new plugin
  install|i [options] <plugin>         Install a plugin from available marketplaces
  list [options]                       List installed plugins
  marketplace                          Manage Claude Code marketplaces
  uninstall|remove [options] <plugin>  Uninstall an installed plugin
  update [options] <plugin>            Update a plugin to the latest version`

const CLAUDE_LIST_HELP = `Usage: claude plugin list [options]

Options:
  --available  Include available plugins from marketplaces (requires --json)
  --json       Output as JSON`

const CODEX_HELP = `Manage Codex plugins

Usage: codex plugin [OPTIONS] <COMMAND>

Commands:
  add          Install a plugin from a configured marketplace snapshot
  list         List plugins available from configured marketplace snapshots
  marketplace  Add, list, upgrade, or remove configured plugin marketplaces
  remove       Remove an installed plugin from local config and cache`

const CODEX_LIST_HELP = `Usage: codex plugin list [OPTIONS]

Options:
      --available
      --json`

const CLAUDE_JSON = JSON.stringify({
  installed: [{ id: 'superpowers@claude-plugins-official', version: '6.3.0', scope: 'user', enabled: true }],
  available: [
    { pluginId: 'superpowers@claude-plugins-official', name: 'superpowers', description: '一堆技能', marketplaceName: 'claude-plugins-official', installCount: 90000 },
    { pluginId: 'adobe-for-creativity@claude-plugins-official', name: 'adobe-for-creativity', description: 'Adobe 那套', marketplaceName: 'claude-plugins-official', installCount: 120 },
  ],
})

const CODEX_JSON = JSON.stringify({
  installed: [{ pluginId: 'documents@openai-primary-runtime', name: 'documents', marketplaceName: 'openai-primary-runtime', version: '26.903.11726', installed: true, enabled: true }],
  available: [{ pluginId: 'latex@openai-bundled', name: 'latex', marketplaceName: 'openai-bundled', version: '0.2.6', installed: false, enabled: false }],
})

describe('parsePluginHelp', () => {
  it('★claude:装是 install、卸是 uninstall', () => {
    expect(parsePluginHelp(CLAUDE_HELP, CLAUDE_LIST_HELP)).toMatchObject({
      plugin: true, list: true, json: true, available: true, installVerb: 'install', removeVerb: 'uninstall', marketplace: true,
    })
  })
  it('★★codex:装是 add、卸是 remove —— 写死 install 的话,codex 上点安装就是一句 unknown command', () => {
    expect(parsePluginHelp(CODEX_HELP, CODEX_LIST_HELP)).toMatchObject({
      plugin: true, list: true, json: true, available: true, installVerb: 'add', removeVerb: 'remove',
    })
  })
  it('★--json 只写在 `plugin list --help` 里 —— 只看顶层 help 会判成没有', () => {
    expect(parsePluginHelp(CODEX_HELP).json).toBe(false)
    expect(parsePluginHelp(CODEX_HELP, CODEX_LIST_HELP).json).toBe(true)
  })
  it('没有 plugin 子命令的 CLI', () => {
    expect(parsePluginHelp("error: unrecognized subcommand 'plugin'").plugin).toBe(false)
    expect(parsePluginHelp('').plugin).toBe(false)
  })
})

describe('parsePluginList', () => {
  it('claude:装了的标成已安装,带说明和安装量,按安装量排', () => {
    const out = parsePluginList(CLAUDE_JSON)
    expect(out.map(p => p.name)).toEqual(['superpowers', 'adobe-for-creativity'])
    expect(out[0]).toMatchObject({ installed: true, installs: 90000, description: '一堆技能' })
    expect(out[1].installed).toBe(false)
  })

  it('★★claude 的 available 条目**不带 installed 字段** —— 合表时不能把已装的覆盖成未装', () => {
    const out = parsePluginList(CLAUDE_JSON)
    expect(out.find(p => p.name === 'superpowers')!.installed).toBe(true)
  })

  it('★同一个插件在两个列表里各出现一次 → 合成一条,不是两条', () => {
    expect(parsePluginList(CLAUDE_JSON).filter(p => p.name === 'superpowers').length).toBe(1)
  })

  it('codex:没有说明就是空串(别编),版本和 installed 用它自己的', () => {
    const out = parsePluginList(CODEX_JSON)
    expect(out.find(p => p.name === 'documents')).toMatchObject({ installed: true, version: '26.903.11726', description: '' })
    expect(out.find(p => p.name === 'latex')).toMatchObject({ installed: false, version: '0.2.6' })
  })

  it('坏 JSON / 空 → 空表,不抛', () => {
    expect(parsePluginList('boom')).toEqual([])
    expect(parsePluginList('[]')).toEqual([])
  })
})

describe('cutToJson', () => {
  it('★★把 CLI 前面那几行噪音切掉 —— 这台机器上 shell 给 claude 套了个函数,每次先打「🚀 启动…」', () => {
    const raw = '🚀 启动 Claude...\n🛡️ 正在检查...\n{"installed":[],"available":[]}'
    expect(JSON.parse(cutToJson(raw))).toEqual({ installed: [], available: [] })
  })
  it('一个 JSON 都没有 → 空串', () => {
    expect(cutToJson('command not found')).toBe('')
  })
})

function make(over: Partial<PluginDeps> = {}) {
  const runs: string[][] = []
  const deps: PluginDeps = {
    binFor: async () => '/usr/local/bin/claude',
    envFor: () => ({}),
    run: async (_b, args) => {
      runs.push(args)
      if (args[1] === '--help') return { stdout: CLAUDE_HELP, code: 0 }
      if (args[2] === '--help') return { stdout: CLAUDE_LIST_HELP, code: 0 }
      return { stdout: '🚀 启动 Claude...\n' + CLAUDE_JSON, code: 0 }
    },
    ...over,
  }
  return { m: new PluginMarket(deps), runs }
}

describe('PluginMarket', () => {
  it('列表:带上 --available --json,并且切掉前面的噪音', async () => {
    const { m, runs } = make()
    const out = await m.list('claude')
    expect(out.length).toBe(2)
    expect(runs.at(-1)).toEqual(['plugin', 'list', '--available', '--json'])
  })

  it('★装:用探出来的动词(claude=install)', async () => {
    const { m, runs } = make()
    await m.install('claude', 'superpowers@claude-plugins-official')
    expect(runs.at(-1)).toEqual(['plugin', 'install', 'superpowers@claude-plugins-official'])
  })

  it('★★装:codex 用的是 add —— 同一颗按钮,两个动词', async () => {
    const { m, runs } = make({
      run: async (_b, args) => {
        if (args[1] === '--help') return { stdout: CODEX_HELP, code: 0 }
        if (args[2] === '--help') return { stdout: CODEX_LIST_HELP, code: 0 }
        return { stdout: '', code: 0 }
      },
    })
    await m.install('codex', 'latex@openai-bundled')
    void runs
    // 用另一个捕获器验证(上面的 runs 属于默认 deps)
    const seen: string[][] = []
    const { m: m2 } = make({
      run: async (_b, args) => {
        seen.push(args)
        if (args[1] === '--help') return { stdout: CODEX_HELP, code: 0 }
        if (args[2] === '--help') return { stdout: CODEX_LIST_HELP, code: 0 }
        return { stdout: '', code: 0 }
      },
    })
    await m2.uninstall('codex', 'latex@openai-bundled')
    expect(seen.at(-1)).toEqual(['plugin', 'remove', 'latex@openai-bundled'])
  })

  it('★命令失败要抛,并且把 CLI 原话带上 —— 静默失败会让人以为装上了', async () => {
    const { m } = make({
      run: async (_b, args) => {
        if (args[1] === '--help') return { stdout: CLAUDE_HELP, code: 0 }
        if (args[2] === '--help') return { stdout: CLAUDE_LIST_HELP, code: 0 }
        return { stdout: 'Error: plugin not found in any marketplace', code: 1 }
      },
    })
    await expect(m.install('claude', 'nope@x')).rejects.toThrow('not found in any marketplace')
  })

  it('没装这个 CLI / 它没有 plugin 子命令 → 空表,不抛', async () => {
    expect(await make({ binFor: async () => null }).m.list('x')).toEqual([])
    const { m } = make({ run: async () => ({ stdout: 'unknown command', code: 1 }) })
    expect(await m.list('x')).toEqual([])
  })

  it('能力只探一次', async () => {
    const { m, runs } = make()
    await m.capsFor('claude')
    await m.capsFor('claude')
    expect(runs.length).toBe(2)
  })
})
