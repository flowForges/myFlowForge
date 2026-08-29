import { execa } from 'execa'

/**
 * 「这台机器上,这个 provider 到底登录了没有」。
 *
 * ★★为什么必须有:`detect.ts` 只查 **bin 在不在**。远程/无头场景下你看不见那台机器,
 *  于是流程是「建会话 → 发消息 → 等半天 → 才发现根本没登录」(设计文档第九节第 2 条)。
 *
 * ★★★三态,不是两态。**`unknown` 是这里最重要的一个值。**
 *  设计文档那张表里一半 CLI 写着「待测」—— 对那些,我们**没有**判断依据。
 *  把「不知道」显示成「没登录」是在撒谎:用户会去重新登录一个本来好好的 provider,
 *  然后发现问题还在。所以只有拿到**否定的证据**才说没登录,拿不到就闭嘴。
 *
 * ★下面每一条 `args` 和 `parse` 都是 2026-08-30 在本机**真跑过**的:
 *  `claude auth status` 回一段 JSON(`{"loggedIn":true,...}`);
 *  `codex login status` 回一行人话(`Logged in using ChatGPT`);
 *  `cursor-agent status` 在没登录时回 `Not logged in`(本机实测就是这个状态);
 *  `opencode auth list` 回 `0 credentials`。
 *  **没跑过的一律不写进这张表**(gemini / qwen / qoder / copilot 的 status …),写了就是在猜。
 */

export type AuthState = 'ok' | 'missing' | 'unknown'

/**
 * 环境变量里有 key 就当登录了 —— 而且**优先于**问 CLI。
 *
 * ★理由:`ANTHROPIC_API_KEY` 摆在那儿时,`claude auth status` 很可能仍然报 `loggedIn:false`
 *  (它说的是 OAuth 那条路),但请求照样能发出去。先看 env 才不会把一台能用的机器标成没登录。
 */
const ENV_KEYS: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
  // 帮助原文里写死的优先级顺序。copilot **没有** status 子命令(实测),所以 env 是它唯一的正面证据;
  // 拿不到就是 unknown —— 它的令牌在系统钥匙串里,没有便宜的查法。
  copilot: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
}

/** 从一段可能夹着别的输出的文本里,把第一个 JSON 对象抠出来。 */
function firstJson(text: string): Record<string, unknown> | null {
  const i = text.indexOf('{')
  const j = text.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try {
    const v: unknown = JSON.parse(text.slice(i, j + 1))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch { return null }
}

/** 剥掉 ANSI 颜色码。`opencode` 的输出带一堆,不剥的话正则对不上。 */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

function matchLogin(out: string): AuthState {
  const t = stripAnsi(out).toLowerCase()
  // ★★否定判断必须在前:「not logged in」里**包含**「logged in」,顺序反了就永远报已登录 ——
  //  而那正好是最坏的方向(把没登录说成登录了,人还是会等半天)。
  if (/not logged in|no credentials|please (run )?login|未登录|没有登录/.test(t)) return 'missing'
  if (/logged in|已登录/.test(t)) return 'ok'
  return 'unknown'
}

export type CredProbe = {
  args: string[]
  parse: (out: string) => AuthState
}

/**
 * ★用户的 shell 里可能套着 wrapper(本机 `claude` 前面就有一层会打印
 *  「🚀 启动 Claude…」「✅ 当前: <ip>」的代理检查器)。所以**绝不能**假设 stdout 是纯净的:
 *  claude 那条要在噪音里找 JSON,另外几条用「包含某句话」而不是「等于某句话」。
 */
export const PROBES: Record<string, CredProbe> = {
  claude: {
    args: ['auth', 'status'],
    parse: (out) => {
      const j = firstJson(out)
      if (!j || typeof j.loggedIn !== 'boolean') return 'unknown'
      return j.loggedIn ? 'ok' : 'missing'
    },
  },
  codex: { args: ['login', 'status'], parse: matchLogin },
  cursor: { args: ['status'], parse: matchLogin },
  opencode: {
    args: ['auth', 'list'],
    parse: (out) => {
      const m = /(\d+)\s+credential/i.exec(stripAnsi(out))
      if (!m) return 'unknown'
      return Number(m[1]) > 0 ? 'ok' : 'missing'
    },
  },
}

export type ProbeDeps = {
  run?: (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string>
  timeoutMs?: number
}

/** 默认实现:跑一次,**stdout 和 stderr 都要**(有的 CLI 把状态打在 stderr 上)。 */
async function defaultRun(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  const r = await execa(bin, args, { env, timeout: timeoutMs, reject: false, all: true })
  return r.all ?? `${r.stdout ?? ''}\n${r.stderr ?? ''}`
}

/**
 * 查一个 provider 的登录状态。
 *
 * ★**永远不抛**,而且带超时:探测坐在 `detectProviders` 的路径上,而那条路径决定
 *  「设置里那一排 agent 显不显示」。一个卡住的 CLI 不能把整排 agent 拖没。
 */
export async function probeAuth(
  providerId: string,
  bin: string | undefined,
  env: NodeJS.ProcessEnv,
  deps: ProbeDeps = {},
): Promise<AuthState> {
  for (const k of ENV_KEYS[providerId] ?? []) {
    if ((env[k] ?? '').trim()) return 'ok'
  }
  const probe = PROBES[providerId]
  if (!probe || !bin) return 'unknown'
  const run = deps.run ?? defaultRun
  const timeoutMs = deps.timeoutMs ?? 10_000
  try {
    return probe.parse(await run(bin, probe.args, env, timeoutMs))
  } catch {
    // 跑不起来 / 超时 —— 这是「不知道」,**不是**「没登录」。见文件头。
    return 'unknown'
  }
}
