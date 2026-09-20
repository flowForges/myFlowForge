import { describe, it, expect } from 'vitest'
import { execa } from 'execa'
import { McpService } from './mcpService'
import { scanAddons } from './addons'
import { PluginMarket } from './pluginMarket'
import { lookupBin } from './lookupBin'

/**
 * 对着**真 CLI** 跑一遍 MCP 那条路。默认不跑 —— 它要起真进程、还要走网络做健康检查。
 *
 *   FORGE_MCP_SMOKE=1 npx vitest run src/main/agents/mcpSmoke.test.ts
 *
 * ★为什么值得留在仓库里(而不是当一次性脚本用完就删):这一层解析的是**别人家 CLI 的人看的输出**,
 *  claude 那边连 `--json` 都没有。哪天 claude 换一版把 `- ✔ Connected` 改成别的写法,
 *  单测(拿着 2026-09-05 抓的样本)会**全绿**,而面板上一台服务器都不显示。
 *  只有这一条能照出来。发版前手动跑一次。
 * ★不做写操作:不 login、不 logout、不 add —— 那些会动用户真实的凭据。
 */
const ON = process.env.FORGE_MCP_SMOKE === '1'

describe.runIf(ON)('真 CLI:mcp 子命令', () => {
  const svc = new McpService({
    binFor: async (id) => await lookupBin(id, process.env),
    envFor: () => ({ ...process.env }),
    run: async (bin, args, cwd, env) => {
      const r = await execa(bin, args, { cwd, env, reject: false, timeout: 60_000, all: true })
      return { stdout: String(r.all ?? r.stdout ?? ''), code: typeof r.exitCode === 'number' ? r.exitCode : 1 }
    },
    spawnPty: () => { throw new Error('冒烟测试不做写操作,不该起 pty') },
  })

  it('claude:探得到 list/login/logout 和 --no-browser', async () => {
    const caps = await svc.capsFor('claude')
    expect(caps).toMatchObject({ mcp: true, list: true, login: true, logout: true })
    // ★这一条是「手机上也能授权」那条链的地基:没有 --no-browser 就只能在主机上开浏览器。
    expect(caps.noBrowser).toBe(true)
    expect(caps.json).toBe(false)   // claude 至今没有 --json,所以我们在解析人看的文本
  }, 60_000)

  it('claude:列得出服务器,而且每条都有名字和状态', async () => {
    const list = await svc.list('claude', process.cwd())
    for (const s of list) {
      expect(s.name).toBeTruthy()
      expect(s.detail).toBeTruthy()
      // ★unknown 说明我们没看懂它说的状态 —— 出现了就是该更新映射表的信号。
      expect(s.auth, `没看懂这条状态:${s.detail}`).not.toBe('unknown')
    }
  }, 120_000)

  it('codex:有 --json,列表走结构化那条', async () => {
    const caps = await svc.capsFor('codex')
    expect(caps).toMatchObject({ mcp: true, list: true, json: true })
    const list = await svc.list('codex', process.cwd())
    for (const s of list) expect(s.name).toBeTruthy()
  }, 60_000)
})

describe.runIf(ON)('真机器:加载项扫描', () => {
  it('扫得到这台机器上真实的 skill / rule / MCP,并打印一份给人看', () => {
    const { addons } = scanAddons()
    const n = (k: string) => addons.filter(a => a.kind === k).length
    console.log(`  skill=${n('skill')} rule=${n('rule')} mcp=${n('mcp')}`)
    for (const a of addons.slice(0, 12)) console.log(`   ${a.kind.padEnd(5)} ${a.provider.padEnd(7)} ${a.name}  ←  ${a.path}`)
    // ★不断言"必须有几个"(每台机器都不一样),只钉住形状:每条都得有 provider 和存在的路径。
    for (const a of addons) {
      expect(a.provider, JSON.stringify(a)).toBeTruthy()
      expect(a.path, JSON.stringify(a)).toBeTruthy()
      expect(a.id.includes(a.name)).toBe(true)
    }
  }, 60_000)
})

describe.runIf(ON)('真 CLI:插件市场', () => {
  const market = new PluginMarket({
    binFor: async (id) => await lookupBin(id, process.env),
    envFor: () => ({ ...process.env }),
    run: async (bin, args, cwd, env) => {
      const r = await execa(bin, args, { cwd, env, reject: false, timeout: 90_000, all: true })
      return { stdout: String(r.all ?? r.stdout ?? ''), code: typeof r.exitCode === 'number' ? r.exitCode : 1 }
    },
  })

  it('★claude:动词是 install/uninstall,列得出市场里的插件', async () => {
    const caps = await market.capsFor('claude')
    expect(caps).toMatchObject({ plugin: true, list: true, json: true, installVerb: 'install', removeVerb: 'uninstall' })
    const list = await market.list('claude')
    console.log(`  claude 插件:共 ${list.length},已装 ${list.filter(p => p.installed).length}`)
    for (const p of list.slice(0, 5)) console.log(`   ${p.installed ? '✓' : ' '} ${p.name}  (${p.marketplace}${p.installs ? `, ${p.installs} 装` : ''})`)
    expect(list.length).toBeGreaterThan(0)
    for (const p of list) expect(p.id).toContain(p.name)
  }, 120_000)

  it('★★codex:动词是 add/remove —— 和 claude 不一样,写死一个必错一个', async () => {
    const caps = await market.capsFor('codex')
    expect(caps).toMatchObject({ plugin: true, list: true, json: true, installVerb: 'add', removeVerb: 'remove' })
    const list = await market.list('codex')
    console.log(`  codex 插件:共 ${list.length},已装 ${list.filter(p => p.installed).length}`)
    expect(list.length).toBeGreaterThan(0)
  }, 120_000)
})
