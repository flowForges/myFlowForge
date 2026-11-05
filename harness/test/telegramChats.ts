// Task 9 起的夹具:配好对的内核 + 真 loop-direct。消息走完整条路:长轮询 → 队列 → 防抖 → session.prompt → 发送器
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createGit, type Git } from '../src/lib/git/snapshot'
import type { ModelEvent } from '../src/lib/models/types'
import { createChannelTelegram, type ChannelTelegramOpts } from '../src/plugins/channel-telegram/index'
import loopDirect from '../src/plugins/loop-direct'
import type { Req, Script } from './memoryRig'
import { telegramKernel, TEST_TOKEN, type TelegramEnv, type TelegramKernelOpts, type TelegramRig } from './telegramRig'

/** 防抖 700 ms、写间隔 1100 ms、编辑间隔 1500 ms、渲染定时器都走得完 */
export const FLOW = 3000
export const HOUR = 3_600_000

export type ChatRigOpts = TelegramKernelOpts & {
  channel?: Partial<ChannelTelegramOpts>
  noLoop?: boolean
  /** 配上真 git 项目 `api`(`true` 现建一个;`projectKit()` 的结果可先拿去给插件用 git)。会话由真 `/project api` 进,用 `enterProject` */
  project?: ProjectKit | true
}

export interface ProjectKit {
  base: string
  repo: string
  git: Git
  channel: { git: Git; home: string; systemTmp: string }
}

/** 一个临时真 git 仓库、注入了 git 环境的 Git、`systmp` 和 `home`。目录在这个夹具的 rig 关闭时删 */
export function projectKit(): ProjectKit {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-tgproj-')))
  const repo = join(base, 'repo')
  const home = join(base, 'home')
  const systemTmp = join(base, 'systmp')
  for (const d of [repo, home, systemTmp]) mkdirSync(d)
  const gitconfig = join(base, 'gitconfig')
  writeFileSync(gitconfig, '[user]\n\tname = t\n\temail = t@example.invalid\n[commit]\n\tgpgSign = false\n[init]\n\tdefaultBranch = main\n')
  const extraEnv = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base }
  const path = process.env.PATH ?? '/usr/bin:/bin'
  const env = { PATH: path, HOME: home, USERPROFILE: home, ...extraEnv }
  const sh = (args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' })
  sh(['init', '-q'])
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  sh(['add', '-A'])
  sh(['commit', '-qm', 'init'])
  const git = createGit({ base: { PATH: path, HOME: home }, extraEnv })
  return { base, repo, git, channel: { git, home, systemTmp } }
}

/** 真 `/project api`:真 git 慢,等命令跑完,再让假时间走 */
export async function enterProject(r: TelegramRig) {
  await handled(r, r.dm('/project api'), 20_000)
  await flow(r)
  expect(onDisk(r).chats[String(r.owner)]).toMatchObject({ project: 'api' })
}

export const stateFile = (r: TelegramRig) => join(r.dataDir, 'plugins', 'channel-telegram', 'state.json')
export const onDisk = (r: TelegramRig) => JSON.parse(readFileSync(stateFile(r), 'utf8'))
export const events = (r: TelegramRig, type: string) => r.k.events.after(0).filter(e => e.type === type)
export const users = (r: TelegramRig) => events(r, 'message.user').map(e => e.payload as { turnId: string; text: string; external?: boolean; followUp?: boolean })
export const texts = (r: TelegramRig) => r.fake.outbox(r.owner).map(m => m.text)
export const sends = (r: TelegramRig, method = 'sendMessage') => r.fake.requests.filter(q => q.method === method)
export const chatOf = (r: TelegramRig) => onDisk(r).chats[String(r.owner)]

/** 这条收下了,收下的命令也跑完了(命令不挡轮询,跑完才从记录里移走) */
export const handled = async (r: TelegramRig, updateId: number, timeout = 3000) => {
  await expect.poll(() => onDisk(r).offset, { timeout, interval: 2 }).toBeGreaterThan(updateId)
  await expect.poll(() => onDisk(r).chats[String(r.owner)]?.commands?.length ?? 0, { timeout, interval: 2 }).toBe(0)
}

export const flow = (r: TelegramRig, ms = FLOW) => r.settle({ advance: ms })

/** kill 之后第一个请求可能撞上假服务器刚断的连接:退避在假时钟上,要帮它走。在线了就不再走 */
export async function online(r: TelegramRig) {
  await expect
    .poll(
      async () => {
        const { state } = (await r.k.handle('channel.telegram.status', {})) as { state: string }
        if (state === 'reconnecting') r.clock.advance(2000)
        return state
      },
      { timeout: 3000, interval: 2 },
    )
    .toBe('online')
}

export async function pairedRig(o: ChatRigOpts = {}): Promise<TelegramRig> {
  const { channel, noLoop, plugins, project, ...rest } = o
  const kit = project === true ? projectKit() : project
  const r = await telegramKernel({
    ...rest,
    ...(kit && { config: { ...rest.config, channels: { telegram: { projects: [{ name: 'api', path: kit.repo }] } } } }),
    plugins: env => [...(plugins?.(env) ?? []), ...(noLoop ? [] : [loopDirect])],
    plugin: (env: TelegramEnv) => createChannelTelegram({ ...env, ...kit?.channel, ...channel }),
  })
  if (kit) {
    const close = r.close.bind(r)
    r.close = async () => {
      await close()
      rmSync(kit.base, { recursive: true, force: true })
    }
  }
  await r.k.handle('channel.telegram.setToken', { token: TEST_TOKEN })
  await online(r)
  const { code } = (await r.k.handle('channel.telegram.pairing.begin', {})) as { code: string }
  await handled(r, r.dm(`/pair ${code}`))
  await flow(r, 1200)
  return r
}

/** 一段等开门的流。开门前写一段字;被取消就按取消收尾 */
export function gatedStream(first: string, rest: string) {
  let open = () => {}
  const gate = new Promise<void>(res => (open = res))
  const stream = async function* (req: Req): AsyncIterable<ModelEvent> {
    yield { type: 'text', delta: first }
    await Promise.race([gate, new Promise<void>(res => req.signal?.addEventListener('abort', () => res(), { once: true }))])
    if (req.signal?.aborted) {
      yield { type: 'done', reason: 'cancelled' }
      return
    }
    yield { type: 'text', delta: rest }
    yield { type: 'usage', input: 1, output: 1 }
    yield { type: 'done', reason: 'stop' }
  }
  return { open: () => open(), stream }
}

/** 第 n 次请求走 gated,其余正常说话 */
export function gatedScript(gated: ReturnType<typeof gatedStream>, at = 1, reply: (n: number) => string = n => `reply ${n}`): Script {
  return (n, req) =>
    n === at
      ? gated.stream(req)
      : (async function* (): AsyncIterable<ModelEvent> {
          yield { type: 'text', delta: reply(n) }
          yield { type: 'done', reason: 'stop' }
        })()
}

/** 在假服务器上攒一批,回来时 getUpdates 一次拿走 */
export async function asOneBatch(r: TelegramRig, send: () => number): Promise<number> {
  r.fake.offline = true
  await expect.poll(async () => ((await r.k.handle('channel.telegram.status', {})) as { state: string }).state, { timeout: 3000, interval: 2 }).toBe('reconnecting')
  const last = send()
  r.fake.offline = false
  await expect
    .poll(
      () => {
        r.clock.advance(1000)
        return onDisk(r).offset
      },
      { timeout: 3000, interval: 5 },
    )
    .toBeGreaterThan(last)
  return last
}

/** 把一个现成的会话种成这个聊天的当前会话:kill 重启让插件读到(项目模式 Task 11 才有入口) */
export async function adoptSession(r: TelegramRig, sessionId: string, chat: object = {}) {
  const seeded = onDisk(r)
  seeded.chats[String(r.owner)] = { ...seeded.chats[String(r.owner)], sessionId, queue: [], ...chat }
  writeFileSync(stateFile(r), JSON.stringify(seeded))
  await r.restart({ kill: true })
  await online(r)
}
