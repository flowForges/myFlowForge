// 09 Task 11 Step 1:一次从头到尾。本地 git 仓库 → prepare → status → confirm(带授权)→ 新会话 → 第一条请求里有索引 →
// 假模型 skill read、mcp tools、mcp call(过审批)→ plugins.command.run → 停用后 mcp call 被拒 → 新 commit 的升级有差异 → 卸载,快照一致。
// 两种沙箱各跑一遍:stub 在 full、计划不包沙箱;真 Seatbelt 带 05 的 skipIf。服务是假服务,模型是剧本
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { alive, call, installedFile, settled, snapshot, storeOf, until } from '../../../test/managerRig'
import { calling, say, type Req } from '../../../test/memoryRig'
import { fakeOutside, mcpRig, type McpRig, type McpRigOpts } from '../../../test/mcpRig'
import { startFakeUpstream, type FakeServer } from '../../../test/fakeUpstream'
import { buildPlugin, buildRepo, FAKE_MCP, type PluginRig } from '../../../test/pluginRig'
import { createGit } from '../../lib/git/snapshot'
import type { KernelEvent } from '../../protocol/index'

const usable = process.platform === 'darwin' && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0

let upstream: FakeServer | undefined
beforeAll(async () => {
  if (usable) upstream = await startFakeUpstream()
})
afterAll(async () => {
  await upstream?.close()
})

const temps: string[] = []
const rigs: McpRig[] = []
afterEach(async () => {
  for (const m of rigs.splice(0)) await m.dispose()
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true })
})

/** 和 buildRepo 同一套隔离环境,在同一个仓库上再提交一次 */
function commitAgain(dir: string, change: (repo: string) => void): string {
  const repo = join(dir, 'repo')
  change(repo)
  const env = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: dir, USERPROFILE: dir, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: dirname(dir) }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('add', '-A')
  git('commit', '-qm', 'second')
  return git('rev-parse', 'HEAD').trim()
}

const cardsOf = (events: KernelEvent[]) => events.filter(e => e.type === 'approval.requested').map(e => e.payload as { approvalId: string; summary: string; key?: string })
const ended = (r: PluginRig, sid: string) => r.events(sid).filter(e => e.type === 'turn.ended' || e.type === 'turn.failed').length
const resultsOf = (req: Req) =>
  Object.fromEntries(
    req.messages
      .filter(x => x.role === 'tool')
      .flatMap(x => x.parts)
      .filter(p => p.type === 'tool_result')
      .map(p => [(p as { callId: string }).callId, String((p as { content: unknown }).content)]),
  )
const firstTexts = (req: Req) => req.messages[0].parts.map(p => (p.type === 'text' ? p.text : ''))

/** 一轮,卡片出现一张就批一张(只批这一次);返回这一轮出现的卡片 */
async function turnApproving(m: McpRig, sid: string, text: string) {
  const seen = cardsOf(m.r.events(sid)).length
  let done = false
  const turn = m.r.turn(sid, text).finally(() => {
    done = true
  })
  let answered = seen
  while (!done) {
    const now = cardsOf(m.r.events(sid))
    for (; answered < now.length; answered++) await call(m.r, 'approval.respond', { approvalId: now[answered].approvalId, decision: 'allow' })
    await new Promise(res => setTimeout(res, 3))
  }
  await turn
  return cardsOf(m.r.events(sid)).slice(seen)
}

interface Mode {
  name: string
  skip: boolean
  rig(): Promise<McpRig>
  /** 插件根里要放的,和 .mcp.json 里的服务 */
  server(tmp: string): { extra: Record<string, string>; entry: object }
}

const MODES: Mode[] = [
  {
    name: 'stub sandbox at full, plan not wrapped',
    skip: false,
    rig: () => mcpRig({ level: 'full' }),
    // 存储外面的假服务:stub 下它真的会写 calls.jsonl,写进存储就过不了下一次启动的完整性检查
    server: tmp => ({ extra: {}, entry: fakeOutside(join(tmp, 'outside'), {}).entry() }),
  },
  {
    name: 'real Seatbelt',
    skip: !usable,
    rig: () => {
      const gitBase = { PATH: '/usr/bin:/bin', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
      const o: McpRigOpts = {
        stub: false,
        level: 'full',
        kernel: {
          sandbox: {
            detect: () => ({ level: 'full' as const, missing: [] }),
            upstream: { url: new URL(`http://127.0.0.1:${upstream!.port}`), noProxy: () => false },
            lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
            git: createGit({ base: gitBase }),
          },
        },
      }
      return mcpRig(o).then(m => {
        // node 从 PATH 来,不在临时 home 下
        m.r.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`
        return m
      })
    },
    // 服务在插件根里,沙箱里存储不可写:calls.jsonl 落回 $HOME(服务自己的数据目录)
    server: () => ({ extra: { 'fake-mcp.mjs': readFileSync(FAKE_MCP, 'utf8'), 'scenario.json': '{}' }, entry: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/fake-mcp.mjs'] } }),
  },
]

describe.each(MODES)('one integration run: $name', mode => {
  it.skipIf(mode.skip)('git → consent → grant → skill, tools, call with a card → command → disable refuses → upgrade diff → uninstall leaves nothing', async () => {
    // /tmp:系统临时目录里像令牌的段在同意页里会被打码,这里要看原样的 args
    const tmp = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'mffai-integ-')))
    temps.push(tmp)
    const m = await mode.rig()
    rigs.push(m)
    const r = m.r

    // ---------- 安装前的快照 ----------
    writeFileSync(join(r.dataDir, 'config.json'), JSON.stringify({ version: 1 }))
    const secretsFile = join(r.dataDir, 'credentials.json')
    const take = () => ({
      code: snapshot(storeOf(r)),
      data: snapshot(join(r.dataDir, 'plugin-data')),
      record: existsSync(installedFile(r)) ? readFileSync(installedFile(r)).toString('hex') : null,
      config: readFileSync(join(r.dataDir, 'config.json')).toString('hex'),
      secrets: existsSync(secretsFile) ? Object.keys(JSON.parse(readFileSync(secretsFile, 'utf8'))).sort() : [],
    })
    const before = take()

    // ---------- 本地 git 仓库 → prepare → status ----------
    const srv = mode.server(tmp)
    const root = buildPlugin(join(tmp, 'src'), {
      format: 'claude',
      id: 'demo',
      skills: { guide: { description: 'how to greet', body: 'Greet with the echo tool. Version one.' } },
      commands: { hello: '---\ndescription: say hello\n---\nSay hello to $ARGUMENTS.\n' },
      mcp: { y: srv.entry },
      extra: srv.extra,
    })
    const repoDir = join(tmp, 'git')
    const { url, commit } = buildRepo(repoDir, root)
    const { stagingId } = await call(r, 'plugins.install.prepare', { source: { kind: 'git', url } })
    const st = await settled(r, stagingId)
    expect(st.state, String(st.error)).toBe('ready')
    const consent = st.consent!
    expect(consent.source).toEqual({ kind: 'git', url, commit })
    expect(consent.skills.map(s => s.name)).toEqual(['guide'])
    expect(consent.commands.map(c => c.name)).toEqual(['hello'])
    expect(consent.mcp.map(s => [s.name, s.problems])).toEqual([['y', []]])
    expect(existsSync(storeOf(r)) ? readdirSync(storeOf(r)).filter(n => n !== '.staging') : []).toEqual([])

    // ---------- confirm,带一个域名的授权 ----------
    const grants = { servers: { y: { network: ['api.example.com'], cwd: 'read' as const } } }
    expect(await call(r, 'plugins.install.confirm', { commandId: 'ci', stagingId, consentHash: st.consentHash, grants, enable: true })).toMatchObject({ ok: true })
    expect((await call(r, 'plugins.list')).plugins).toEqual([expect.objectContaining({ id: 'demo', enabled: true, state: 'ok' })])
    // git 的进程也经同一个 spawn:这里只看服务
    const servers = () => m.spawns.filter(c => c[0] !== 'git')
    expect(servers()).toEqual([])

    // ---------- 新会话:第一条请求里有索引;skill read、mcp tools、mcp call ----------
    const sid = await r.session({ approvalMode: 'ask' })
    m.queue.push(
      calling('c1', 'skill', { action: 'read', name: 'demo:guide' }),
      calling('c2', 'mcp', { action: 'tools', server: 'demo/y' }),
      calling('c3', 'mcp', { action: 'call', server: 'demo/y', tool: 'echo', arguments: { hello: 'world' } }),
      say('done'),
    )
    const cards = await turnApproving(m, sid, 'greet the world')
    const reqs = r.models.foreground().map(c => c.req)
    const index = firstTexts(reqs[0]).find(t => t.startsWith('<plugin-index>'))
    expect(index).toContain('demo:guide — how to greet')
    expect(index).toContain('demo/y')
    expect((reqs[0].tools ?? []).map(t => t.name)).toEqual(expect.arrayContaining(['skill', 'mcp']))
    const results = resultsOf(reqs.at(-1)!)
    expect(results.c1.split('\n')[0]).toBe('<plugin-skill plugin="demo" skill="guide">')
    expect(results.c1).toContain('Version one.')
    expect(results.c2).toContain('echo')
    expect(results.c3.split('\n')[0]).toBe('<mcp-result server="demo/y" tool="echo">')
    expect(results.c3).toContain('"hello":"world"')
    // 有网的服务:先是 --start 的卡片,再是 call 的;skill read 不要卡片
    expect(cards.map(c => c.key)).toEqual([expect.stringMatching(/^mcp-start demo\/y#/), expect.stringMatching(/^mcp demo\/y echo#/)])
    expect(cards[1].summary).toContain('api.example.com')
    expect(m.live()).toHaveLength(1)

    // ---------- plugins.command.run ----------
    m.queue.push(say('hello done'))
    const want = ended(r, sid) + 1
    const ran = await call(r, 'plugins.command.run', { commandId: 'cmd', sessionId: sid, name: 'demo:hello', args: 'the team' })
    expect(ran).toMatchObject({ accepted: true })
    await until(() => ended(r, sid) >= want)
    const external = r.events(sid).filter(e => e.type === 'message.user' && (e.payload as { external?: boolean }).external === true)
    expect(external).toHaveLength(1)
    const sent = (external[0].payload as { text: string }).text
    expect(sent.split('\n')[0]).toBe('<plugin-command plugin="demo" command="hello">')
    expect(sent).toContain('Say hello to the team.')

    // ---------- 停用:进程没了,下一次 mcp call 被拒,什么都不起 ----------
    await call(r, 'plugins.setEnabled', { commandId: 'off', id: 'demo', enabled: false })
    await until(() => m.live().length === 0, 6000)
    const spawned = servers().length
    m.queue.push(calling('c4', 'mcp', { action: 'call', server: 'demo/y', tool: 'echo', arguments: { again: true } }), say('refused'))
    expect(await turnApproving(m, sid, 'once more')).toEqual([])
    expect(resultsOf(r.models.foreground().at(-1)!.req).c4).toBe('plugin_disabled')
    expect(servers().length).toBe(spawned)

    // ---------- 新 commit 的升级:差异看得到,确认后是新的 commit ----------
    const second = commitAgain(repoDir, repo => writeFileSync(join(repo, 'skills', 'guide', 'SKILL.md'), '---\nname: guide\ndescription: how to greet\n---\nGreet with the echo tool. Version two.\n'))
    expect(second).not.toBe(commit)
    const up = await call(r, 'plugins.upgrade.prepare', { id: 'demo' })
    const ust = await settled(r, up.stagingId)
    expect(ust.state, String(ust.error)).toBe('ready')
    const diff = ust.consent!.diff!
    expect(diff.skills.textChanged).toEqual(['guide'])
    expect(diff.mcp).toEqual({ added: [], removed: [], changed: [] })
    expect(diff.integrity).not.toBeNull()
    expect(ust.consent!.source).toMatchObject({ kind: 'git', commit: second })
    expect(await call(r, 'plugins.install.confirm', { commandId: 'cu', stagingId: up.stagingId, consentHash: ust.consentHash, grants, enable: false })).toMatchObject({ ok: true })
    const detail = await call(r, 'plugins.get', { id: 'demo' })
    expect(detail.consent.source).toMatchObject({ commit: second })
    // 升级后的授权是交集:声明里还在,所以原样留着
    expect(detail.grants).toEqual(grants)

    // ---------- 卸载:和安装前逐字节一致,没有进程 ----------
    expect(await call(r, 'plugins.uninstall', { commandId: 'un', id: 'demo' })).toEqual({ ok: true })
    expect(take()).toEqual(before)
    expect(m.pids.filter(alive)).toEqual([])
    await r.restart()
    expect(take()).toEqual(before)
    expect((await call(r, 'plugins.list')).plugins).toEqual([])
  }, 90_000)
})
