// 07 Task 12:一条完整的路,真插件全上(假的只有模型、CLI、Telegram):
// 配对 → 带记忆的聊天 → /project → 模型改文件 → 按钮批 shell → 派出去的任务挂着时来消息 → /rollback → /new → kill → 接着聊。
// 末尾判所有"不在里面",并判用户的仓库一个字节没动。
// 模型用 memoryRig 的脚本假模型,不是 startFakeOpenai:07 的模型一侧没有新东西,假 OpenAI 另有 e2e 覆盖
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { untilGo } from '../../../test/executorRig'
import { cleanupFakes, installFake } from '../../../test/fakeCli'
import type { FakeMessage } from '../../../test/fakeTelegram'
import { calling, say, type Script } from '../../../test/memoryRig'
import { chatOf, enterProject, events, flow, handled, onDisk, online, pairedRig, projectKit, texts, users } from '../../../test/telegramChats'
import { TEST_TOKEN, type TelegramRig } from '../../../test/telegramRig'
import { createExecutorCli } from '../executor-cli/index'
import { createLoopDefault } from '../loop-default'
import { createMemoryDefault } from '../memory-default'
import { createToolsCoding } from '../tools-coding'
import toolsRegistry from '../tools-registry'

const SECRET = 'sk-' + 'x'.repeat(24)
const rigs: TelegramRig[] = []
const temps: string[] = []
afterEach(async () => {
  await Promise.all(rigs.splice(0).map(r => r.close()))
  cleanupFakes()
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true })
})

type Button = { text: string; callback_data: string }
const keyboard = (m: FakeMessage) => ((m.keyboard as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []).flat()
const pendingCards = (r: TelegramRig) => r.fake.outbox(r.owner).filter(m => keyboard(m).length > 0)

/** 真 git 和真轮比假时间慢:一边让假时间走一边等 */
const until = (r: TelegramRig, what: () => boolean | number, ms = 20_000) =>
  expect
    .poll(
      async () => {
        await flow(r, 1200)
        return what()
      },
      { timeout: ms, interval: 5 },
    )
    .toBeTruthy()

async function say_(r: TelegramRig, text: string) {
  await handled(r, r.dm(text), 20_000)
  await flow(r)
}

it('pair → memory chat → /project → edit → button approval → follow-up during a parked delegate → /rollback → /new → kill → resume', async () => {
  const go = join(mkdtempSync(join(tmpdir(), 'mffai-tg-int-go-')), 'go')
  temps.push(dirname(go))
  const f = installFake(untilGo(go), 'codex')
  const env = { PATH: `${f.dir}:/usr/bin:/bin`, HOME: tmpdir() }
  const kit = projectKit()
  const repoBefore = snapshotOf(kit.repo, kit)

  // 前台请求的序号:记忆没有后台请求(nightly 关,上下文小)
  const script: Script = n => {
    switch (n) {
      case 1: return say('hello owner')
      case 2: return calling('w1', 'write', { path: 'a.txt', content: 'edited\n' })
      case 3: return calling('w2', 'write', { path: 'k.txt', content: `${SECRET}\n` })
      case 4: return say('edited the files')
      case 5: return calling('s1', 'shell', { command: 'cat k.txt && echo ran > out.txt' })
      case 6: return say('ran the shell')
      case 7: return calling('d1', 'delegate_codex', { prompt: 'do it', readOnly: true })
      case 8: return say('started the run')
      case 9: return say('still going')
      case 10: return say('all done')
      default: return say(`reply ${n}`)
    }
  }
  const r = await pairedRig({
    project: kit,
    config: { executors: { disabled: ['qoder'] } },
    models: { script },
    plugins: () => [
      createMemoryDefault({ nightly: false }),
      toolsRegistry,
      createToolsCoding({ shellEnv: env, loginPath: async () => '', git: async () => { throw new Error('no git') } }),
      createExecutorCli({ env, loginPath: async () => '' }),
      createLoopDefault({ git: kit.git }),
    ],
  })
  rigs.push(r)
  const detecting = async () => ((await r.k.handle('executor.list', {})) as { executors: { missing: string[] }[] }).executors.some(x => x.missing.includes('detecting'))
  await expect.poll(detecting, { timeout: 15_000, interval: 10 }).toBe(false)

  // 配对:状态里有这个人,没有别人
  expect(onDisk(r).pairings).toHaveLength(1)

  // 带记忆的聊天
  const memDir = join(r.dataDir, 'plugins', 'memory-default', 'files')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(memDir, 'USER.md'), '- 喜欢简短回复\n')
  await say_(r, 'hello')
  await until(r, () => r.models.foreground().length >= 1)
  expect(JSON.stringify(r.models.foreground()[0].req.messages)).toContain('<memory kind=\\"core\\">')
  await until(r, () => texts(r).some(t => t.includes('hello owner')))
  const chatSession = chatOf(r).sessionId

  // /project:改动在 worktree 里
  await enterProject(r)
  const projectSession = chatOf(r).sessionId
  expect(projectSession).not.toBe(chatSession)
  const cwd = (events(r, 'session.created').at(-1)!.payload as { cwd: string }).cwd
  expect(cwd).not.toBe(kit.repo)

  // 模型改文件(write 不问,shell 和派出去的任务问)
  await say_(r, 'edit the files')
  await until(r, () => events(r, 'turn.ended').length >= 2)
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('edited\n')

  await say_(r, 'run it')
  await approveByButton(r, 0)
  await until(r, () => events(r, 'turn.ended').length >= 3)
  expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('ran\n')

  // 派出去的任务:卡片批了,挂着的时候来的消息是同一轮的 followUp
  await say_(r, 'delegate it')
  await approveByButton(r, 1)
  await until(r, () => events(r, 'turn.parked').length >= 1)
  await say_(r, 'how is it going')
  await until(r, () => events(r, 'turn.parked').length >= 2)
  const [, , , delegating, follow] = users(r)
  expect(follow).toMatchObject({ text: 'how is it going', followUp: true, turnId: delegating.turnId })
  writeFileSync(go, '')
  await until(r, () => events(r, 'turn.ended').length >= 4)
  expect(texts(r).join('\n')).toContain('all done')

  // /rollback 到没有可回滚的:worktree 回到刚进项目的样子
  for (let i = 0; i < 6; i++) {
    await say_(r, '/rollback')
    if (texts(r).at(-1) === '没有可回滚的') break
  }
  expect(texts(r).at(-1)).toBe('没有可回滚的')
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a\n')
  expect(existsSync(join(cwd, 'k.txt'))).toBe(false)
  expect(existsSync(join(cwd, 'out.txt'))).toBe(false)

  // /new:项目留着,会话换新
  await say_(r, '/new')
  const fresh = chatOf(r)
  expect(fresh.project).toBe('api')
  expect(fresh.sessionId).not.toBe(projectSession)

  // kill:磁盘就是这一刻的样子,接着发消息跑在同一个新会话里
  await r.restart({ kill: true })
  await online(r)
  expect(chatOf(r)).toMatchObject({ project: 'api', sessionId: fresh.sessionId })
  const before = events(r, 'message.user').length
  await say_(r, 'still there?')
  await until(r, () => events(r, 'message.user').length > before)
  expect(events(r, 'message.user').at(-1)!.sessionId).toBe(fresh.sessionId)

  // 不在里面的
  const raw = r.rawBytes({ requests: true })
  const requestBodies = JSON.stringify(r.fake.requests.map(q => q.body))
  expect(raw.includes(TEST_TOKEN)).toBe(false)
  expect(raw.includes(TEST_TOKEN.split(':')[1]!)).toBe(false)
  expect(r.fake.requests.some(q => q.path.includes(TEST_TOKEN))).toBe(true)
  expect(requestBodies).not.toContain(SECRET.slice(0, 10))
  expect(JSON.stringify(await r.k.handle('channel.telegram.status', {}))).not.toContain(TEST_TOKEN)
  expect(JSON.stringify(await r.k.handle('channel.telegram.config.get', {}))).not.toContain(TEST_TOKEN)
  expect(readFileSync(join(r.dataDir, 'config.json'), 'utf8')).not.toContain(TEST_TOKEN)
  expect(JSON.stringify(onDisk(r))).not.toContain(TEST_TOKEN)
  for (const q of r.fake.requests.filter(x => x.method === 'sendMessage' || x.method === 'editMessageText')) {
    expect((q.body as { link_preview_options?: { is_disabled?: boolean } }).link_preview_options?.is_disabled).toBe(true)
  }
  // 四张卡:都在手机上,都已收口
  expect(onDisk(r).cards).toEqual([])
  expect(pendingCards(r)).toEqual([])
  expect(events(r, 'approval.resolved').every(e => (e.payload as { via?: string }).via !== undefined)).toBe(true)

  // 用户的仓库一个字节没动
  expect(snapshotOf(kit.repo, kit)).toEqual(repoBefore)
  expect(readdirSync(kit.repo).sort()).toEqual(['.git', 'a.txt'])
}, 120_000)

/** 第 nth 张卡:等到手机上,按「允许」 */
async function approveByButton(r: TelegramRig, nth: number) {
  await until(r, () => pendingCards(r).length > 0 && (onDisk(r).cards as { messageId?: number }[]).some(c => c.messageId !== undefined))
  const card = pendingCards(r).at(-1)!
  const allow = keyboard(card).find(b => b.text === '允许')!
  const before = events(r, 'approval.resolved').length
  await handled(r, r.press(allow.callback_data, { messageId: card.id }), 20_000)
  await until(r, () => events(r, 'approval.resolved').length > before)
  expect(events(r, 'approval.resolved')).toHaveLength(nth + 1)
  expect(events(r, 'approval.resolved').at(-1)!.payload).toMatchObject({ decision: 'allow', by: 'user', via: `telegram:${r.owner}` })
}

function snapshotOf(repo: string, kit: { base: string }) {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(kit.base, 'home'), GIT_CONFIG_GLOBAL: join(kit.base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: kit.base }
  const sh = (args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return [
    sh(['status', '--porcelain']),
    sh(['for-each-ref', '--format=%(refname) %(objectname)', '--exclude=refs/mffai/**']),
    readFileSync(join(repo, '.git', 'HEAD')).toString('hex'),
    readFileSync(join(repo, '.git', 'index')).toString('hex'),
    readFileSync(join(repo, 'a.txt'), 'utf8'),
  ]
}
