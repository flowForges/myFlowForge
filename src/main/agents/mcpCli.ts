/**
 * 每个 CLI 自己的 `mcp` 子命令 —— 解析层(纯函数,不碰 IO)。
 *
 * ★★为什么不是「支持 `/mcp` 这个斜杠命令」:`/mcp` 是 claude **交互式界面**里的一屏,而我们跑的是
 *  stream-json 非交互模式,那一屏根本不存在。但同样的能力每个 CLI 都另外做成了子命令:
 *    claude: mcp list | get | login <name> [--no-browser] | logout <name>
 *    codex : mcp list --json | get | login | logout
 *  所以做的是一个**管理面板**,底下调它们各自的子命令。用户原话:「provider 是否支持 /mcp 这个命令,
 *  咱们得支持,因为我发现我想 mcp 授权,授权不了」—— 要的是「能授权」,不是要那一屏。
 *
 * ★能力**探测,不预置**(和模型发现同一条规矩,见 feedback-model-discovery-no-presets):
 *  跑一次 `<bin> mcp --help` 看它认得哪几个子命令。写死「claude 和 codex 支持」这种表,
 *  下一个 CLI 加了 login 我们不知道,claude 哪天改了名字我们也不知道。
 */

/** 一台 MCP 服务器在某个 provider 眼里的状态。 */
export type McpAuth =
  | 'connected'      // 连上了(HTTP/SSE 的已授权,stdio 的进程起得来)
  | 'needs-auth'     // ★就是用户撞到的那个:配好了但没授权
  | 'failed'         // 连不上
  | 'pending'        // .mcp.json 里的项目级服务器还没批准
  | 'unsupported'    // 这个传输方式没有 OAuth 这回事(stdio)
  | 'unknown'

export interface McpServer {
  name: string
  /** 地址(HTTP/SSE)或命令行(stdio)。 */
  target: string
  auth: McpAuth
  /** CLI 原话。★永远带着:上面那个枚举是我们**猜**的映射,猜错了至少屏幕上还有真话。 */
  detail: string
}

/** 这个 CLI 的 mcp 子命令认得哪几样。 */
export interface McpCaps {
  mcp: boolean
  list: boolean
  login: boolean
  logout: boolean
  /** `mcp remove <name>`:「加载项」那一页删 MCP 走的就是它(而不是去改配置文件)。 */
  remove: boolean
  /** list 支不支持 --json(codex 有,claude 没有)。 */
  json: boolean
  /** login 支不支持 --no-browser(claude 有;没有的话只能在主机上开浏览器)。 */
  noBrowser: boolean
}

export const NO_MCP: McpCaps = { mcp: false, list: false, login: false, logout: false, remove: false, json: false, noBrowser: false }

/**
 * 解析 `<bin> mcp --help`。
 *
 * ★只认**行首缩进后的第一个词**。直接 `help.includes('login')` 会被正文里任何一句
 * 「…before login…」骗到 —— 而那种误判的后果是界面上摆一颗点了必然报错的授权按钮。
 */
export function parseMcpHelp(help: string): McpCaps {
  if (!help.trim()) return NO_MCP
  const subs = new Set<string>()
  for (const line of help.split('\n')) {
    const m = /^\s{2,}([a-z][a-z-]*)\b/.exec(line)
    if (m) subs.add(m[1])
  }
  const list = subs.has('list')
  const login = subs.has('login')
  return {
    // 一个 mcp 子命令都认不出来 = 这个 CLI 压根没有 mcp(help 是 "unknown command" 之类)。
    mcp: list || login || subs.has('get') || subs.has('add'),
    list,
    login,
    logout: subs.has('logout'),
    remove: subs.has('remove'),
    json: /--json\b/.test(help),
    noBrowser: /--no-browser\b/.test(help),
  }
}

const AUTH_WORDS: [RegExp, McpAuth][] = [
  [/needs? authentication|not logged in|unauthenticated|not authenticated/i, 'needs-auth'],
  [/pending approval|awaiting approval/i, 'pending'],
  [/unsupported|not applicable|n\/a/i, 'unsupported'],
  [/failed|error|disconnected/i, 'failed'],
  [/connected|logged in|authenticated|^ok$/i, 'connected'],
]

/**
 * CLI 说的那句话 → 我们的枚举。认不出来就是 unknown,**不硬塞成「连上了」**。
 * ★顺序有讲究:`not authenticated` 里含着 `authenticated`,`unsupported` 之类要在通用词之前判。
 */
export function authFromText(s: string): McpAuth {
  // ★下划线/连字符先摊成空格:claude 说的是 `Needs authentication`,codex 说的是 `not_logged_in`。
  //  不摊的话 codex 那边**每一条都落到 unknown**,而 unknown 在界面上看着像「读不出来」,
  //  不像「没授权」—— 用户要点的那颗授权按钮就不会出现。
  const t = s.replace(/[_-]+/g, ' ')
  for (const [re, v] of AUTH_WORDS) if (re.test(t)) return v
  return 'unknown'
}

/** 去掉 ANSI 颜色和 OSC 8 超链接包装。CLI 在 pty 里输出的 URL 两边都裹着这些。 */
export function stripAnsi(s: string): string {
  return (
    s
      // OSC 8 超链接:ESC ] 8 ;; <url> BEL … ESC ] 8 ;; BEL。只去外壳,可见文本里那条 URL 还在,不丢信息。
      .replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      // CSI 序列(颜色、光标移动、清行)
      .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
      // 其余单字符 ESC 序列
      .replace(/\u001b[()][A-Z0-9]/g, '')
  )
}

/**
 * 解析 `claude mcp list`(它没有 --json)。每行长这样:
 *   `claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected`
 *   `probe-sentry: https://mcp.sentry.dev/mcp (HTTP) - ! Needs authentication`
 *
 * ★状态按**最后一个 ` - `** 切,不是第一个:stdio 那种的命令行里带 ` - ` 是常事
 *  (`node server.js - --flag`),按第一个切会把半条命令当成状态。
 * ★名字里不许有冒号(实际的服务器名都是标识符)。这条假设写在这儿,别让它变成暗规矩。
 */
export function parseClaudeList(out: string): McpServer[] {
  const servers: McpServer[] = []
  for (const raw of stripAnsi(out).split('\n')) {
    const line = raw.trim()
    if (!line || /^Checking MCP server health/i.test(line)) continue
    const head = /^([^:]+):\s+(.*)$/.exec(line)
    if (!head) continue
    const [, name, rest] = head
    const cut = rest.lastIndexOf(' - ')
    if (cut < 0) continue
    const target = rest.slice(0, cut).trim()
    const detail = rest.slice(cut + 3).trim()
    if (!target || !detail) continue
    servers.push({ name: name.trim(), target, auth: authFromText(detail), detail })
  }
  return servers
}

/** 解析 `codex mcp list --json`。结构化的,但 `auth_status` 的取值集合没有文档,所以照样过 authFromText。 */
export function parseCodexList(json: string): McpServer[] {
  let arr: unknown
  try {
    arr = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: McpServer[] = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name : ''
    if (!name) continue
    const t = (o.transport ?? {}) as Record<string, unknown>
    const target =
      typeof t.url === 'string'
        ? t.url
        : typeof t.command === 'string'
          ? [t.command, ...(Array.isArray(t.args) ? t.args.map(String) : [])].join(' ')
          : typeof t.type === 'string'
            ? t.type
            : ''
    const detail = typeof o.auth_status === 'string' ? o.auth_status : ''
    // ★enabled:false 在 codex 里是**关着的**,不是没授权。别把它显示成「连上了」。
    const auth: McpAuth = o.enabled === false ? 'unknown' : authFromText(detail)
    // ★关着的时候把「disabled」写进 detail 并**保留 CLI 原话** —— 只显示 auth 那个枚举的话,
    //  一台关掉的服务器和一台读不出状态的服务器在屏幕上长得一模一样。
    out.push({ name, target, auth, detail: o.enabled === false ? (detail ? `disabled (${detail})` : 'disabled') : detail })
  }
  return out
}

/**
 * 从 `mcp login` 的输出里抠出授权地址。
 *
 * ★取**第一个** http(s) 地址:后面那些是回调地址 / 文档链接。
 * ★必须先 stripAnsi —— pty 里那条 URL 被 OSC 8 和颜色码切成好几段,不剥壳的话正则会咬到半截。
 */
export function extractAuthUrl(text: string): string | null {
  const m = /https?:\/\/[^\s'"<>）)]+/.exec(stripAnsi(text))
  return m ? m[0] : null
}

/** login 跑完了没有:成功 / 失败 / 还在等。 */
export function loginOutcome(text: string): 'ok' | 'fail' | null {
  const s = stripAnsi(text)
  // ★失败在前:失败那句话里常常也带着 "authentication" 这个词。
  if (/couldn't complete authentication|authentication failed|failed to authenticate|invalid redirect|error:/i.test(s)) return 'fail'
  if (/authentication (successful|complete)|successfully authenticated|logged in to|authorization complete/i.test(s)) return 'ok'
  return null
}

/** CLI 已经在等你把重定向地址粘回去了。 */
export function awaitingPaste(text: string): boolean {
  return /paste the redirect URL/i.test(stripAnsi(text))
}
