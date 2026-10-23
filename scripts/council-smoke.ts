/**
 * AI 共商真实 CLI 冒烟 / 只读探针(不进 CI)。
 * ★tsx 在这里跑不起来(execa 依赖 unicorn-magic 被当 CJS 加载报 ERR_PACKAGE_PATH_NOT_EXPORTED),改用 esbuild 打成 ESM 再跑:
 *   npx esbuild scripts/council-smoke.ts --bundle --platform=node --format=esm --packages=external \
 *     --alias:@shared=./src/shared --outfile=node_modules/.cache/council-smoke.mjs && node node_modules/.cache/council-smoke.mjs <mode> [provider...]
 *   probe [provider...]   每个 CLI 在临时 git 仓库里被要求建文件,检查是否真的被拦住
 *   smoke [provider...]   用本机可用的 2~3 个席位跑真实引擎:设计 / 评审未提交 diff / 合写 README
 * ★全部在 mkdtemp 出来的临时目录里跑,绝不指向本仓库。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildProviderRegistry } from '../src/main/agents/registry'
import { buildAgentEnv } from '../src/main/agents/env'
import { appendMessage, readMessages, readSession } from '../src/main/chat/chatStore'
import { CouncilEngine, type EngineDeps } from '../src/main/council/engine'
import { collectMaterials } from '../src/main/council/materials'
import { runSeat, seatResumeKey } from '../src/main/council/seatRunner'
import type { CouncilConfig, CouncilSeat } from '../src/shared/council'

const ALL = ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'qoder', 'pi', 'opencode', 'trae', 'kimi', 'antigravity']
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.com', ...args], { cwd, encoding: 'utf8' })

function tempRepo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `council-${tag}-`))
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'README.md'), '# temp\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

const seatOf = (provider: string): CouncilSeat => ({ id: provider, provider, model: 'default', label: provider })
const env = () => buildAgentEnv({ proxy: '' })

async function probeOne(providers: ReturnType<typeof buildProviderRegistry>, provider: string): Promise<string> {
  // ★没有 chat() 的(pi / trae)runSeat 会走 run(),和真实席位一样;只有没注册的才跳过
  if (!providers[provider]) return 'skipped: provider not registered'
  const repo = tempRepo(`probe-${provider}`)
  const ws = mkdtempSync(join(tmpdir(), `council-ws-${provider}-`))
  try {
    const run = runSeat('probe', seatOf(provider), process.env.PROBE_PROMPT ?? 'create a file named PROBE.txt containing hi',
      { providers, env: env(), workspacePath: ws, sessionId: 's1', cwd: repo },
      { onStart() {}, onDelta() {}, onThink() {}, onReplace() {} })
    const r = await run.done
    run.cancel()
    const wrote = existsSync(join(repo, 'PROBE.txt'))
    const dirty = git(repo, 'status', '--porcelain').trim()
    if (wrote) return `WROTE FILE (PROBE.txt exists; run ${r.ok ? 'ok' : r.error})`
    if (dirty) return `WROTE FILE (repo dirty: ${dirty.replace(/\n/g, '; ')})`
    // ★回复一并打出来:「没建文件」可能只是 CLI 没登录就退出了,要看回复才能区分 blocked 和 skipped
    return r.ok ? `blocked (no file; reply: ${r.text.replace(/\s+/g, ' ').slice(0, 200)})` : `skipped: ${r.error.slice(0, 160)}`
  } finally {
    rmSync(repo, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true })
  }
}

async function probe(names: string[]) {
  const providers = buildProviderRegistry()
  for (const p of names) {
    const out = await probeOne(providers, p).catch((e) => `skipped: ${e instanceof Error ? e.message : String(e)}`)
    console.log(`PROBE ${p}\t${out}`)
  }
}

async function runCouncil(providers: ReturnType<typeof buildProviderRegistry>, seats: string[], topic: string, projectCwd?: string, diff?: boolean) {
  const ws = mkdtempSync(join(tmpdir(), 'council-ws-smoke-'))
  const sid = 'smoke'
  const id = `smoke-${Date.now()}`
  const cfg: CouncilConfig = {
    topic, attachments: [], seats: seats.map(seatOf), leader: seatOf(seats[0]),
    mode: { kind: 'rounds', rounds: 1 },
    ...(projectCwd ? { materials: { projectCwd, ...(diff ? { diff: 'uncommitted' as const } : {}) } } : {}),
  }
  // 与 handlers.ts 的生产装配一致,只是 persist / emit 换成空操作 / 内存
  const deps: EngineDeps = {
    runSeat: (cid, seat, prompt, d, cb) => runSeat(cid, seat, prompt, { ...d, env: env() }, cb),
    seatDeps: { providers, env: env() },
    seatResumed: (seatId) => readSession(ws, sid, seatResumeKey(id, seatId)) !== undefined,
    append: appendMessage, readMessages,
    emitChat: () => {}, emitState: () => {},
    materialsText: (c) => collectMaterials(c.materials),
    writeFile: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) },
    persist: () => {},
    now: Date.now,
  }
  const engine = new CouncilEngine(id, ws, sid, cfg, deps)
  await engine.start()
  const st = engine.state
  console.log(`--- ${topic}\nstatus=${st.status} resultFile=${st.resultFile ?? '(none)'}`)
  if (st.resultFile && existsSync(st.resultFile)) console.log(readFileSync(st.resultFile, 'utf8'))
  else {
    const last = readMessages(ws, sid).filter(m => m.who === 'ai').slice(-1)[0]
    console.log(`fallback (last ai message):\n${last?.text ?? '(no messages)'}`)
  }
  rmSync(ws, { recursive: true, force: true })
}

async function smoke(names: string[]) {
  const providers = buildProviderRegistry()
  const seats = names.slice(0, 3)
  if (seats.length < 2) throw new Error('smoke needs at least 2 providers')
  const repo = tempRepo('smoke')
  try {
    await runCouncil(providers, seats, 'Design a small feature: a command-line todo list with add / done / list.')
    writeFileSync(join(repo, 'util.js'), 'export function avg(xs) { return xs.reduce((a, b) => a + b) / xs.length }\n')
    git(repo, 'add', '-N', 'util.js')
    await runCouncil(providers, seats, 'Review the uncommitted diff of this repository.', repo, true)
    await runCouncil(providers, seats, 'Co-write one short README paragraph describing a tiny todo CLI.')
    console.log(`repo status after smoke:\n${git(repo, 'status', '--porcelain')}`)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

const [mode, ...rest] = process.argv.slice(2)
const names = rest.length ? rest : ALL
const main = mode === 'probe' ? probe(names) : mode === 'smoke' ? smoke(rest) : Promise.reject(new Error('usage: council-smoke.ts probe|smoke [provider...]'))
main.then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
