import { describe, it, expect } from 'vitest'
import {
  authFromText, awaitingPaste, extractAuthUrl, loginOutcome, parseClaudeList, parseCodexList,
  parseMcpHelp, stripAnsi, NO_MCP,
} from './mcpCli'

/**
 * ★这份测试里的样本**全是 2026-09-05 从真 CLI 上抓的**,不是照着文档编的。
 *  claude 那边没有 `--json`,我们是在解析人看的文本 —— 这种解析唯一靠得住的钉子就是真实输出。
 */

const CLAUDE_LIST = `Checking MCP server health…

claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
probe-sentry: https://mcp.sentry.dev/mcp (HTTP) - ! Needs authentication`

const CLAUDE_HELP = `Usage: claude mcp [options] [command]

Configure and manage MCP servers

Options:
  -h, --help                            Display help for command

Commands:
  add [options] <name> <commandOrUrl> [args...]  Add an MCP server to Claude Code.
  add-json [options] <name> <json>      Add an MCP server with a JSON string
  get <name>                            Get details about an MCP server.
  list                                  List configured MCP servers.
  login [options] <name>                Authenticate with an MCP server (HTTP,
                                        SSE, or claude.ai connector)
  logout <name>                         Clear stored OAuth credentials for an
                                        MCP server
  remove [options] <name>               Remove an MCP server
  serve [options]                       Start the Claude Code MCP server`

const CLAUDE_LOGIN_HELP = `Usage: claude mcp login [options] <name>

Authenticate with an MCP server (HTTP, SSE, or claude.ai connector)

Options:
  -h, --help    Display help for command
  --no-browser  Print the authorization URL instead of opening a browser (for
                SSH/headless sessions — paste the redirect URL back when
                prompted)`

const CODEX_HELP = `Usage: codex mcp [OPTIONS] <COMMAND>

Commands:
  list
  get
  add
  remove
  login
  logout
  help    Print this message or the help of the given subcommand(s)

Options:
  -c, --config <key=value>
      --json
          Output the configured servers as JSON`

// 真 `codex mcp list --json` 的两条(env 那一大坨删了,形状原样)。
const CODEX_JSON = JSON.stringify([
  {
    name: 'omx_wiki', enabled: true, disabled_reason: null,
    transport: { type: 'stdio', command: 'node', args: ['/usr/local/lib/node_modules/oh-my-codex/dist/mcp/wiki-server.js'], env: null, env_vars: [], cwd: null },
    startup_timeout_sec: 5.0, tool_timeout_sec: null, auth_status: 'unsupported',
  },
  {
    name: 'remote-thing', enabled: true, disabled_reason: null,
    transport: { type: 'streamable_http', url: 'https://mcp.example.com/mcp' },
    auth_status: 'not_logged_in',
  },
])

// 真 pty 输出:URL 被 OSC 8 超链接和颜色码裹着(BEL 收尾),而且**同一条地址出现两次**。
const ESC = '\u001b'
const BEL = '\u0007'
const PTY_LOGIN = [
  'Starting authentication for "probe-sentry"…',
  '',
  'Visit this URL to authorize:',
  '',
  `  ${ESC}]8;;https://mcp.sentry.dev/oauth/authorize?response_type=code&client_id=abc${BEL}${ESC}[94mhttps://mcp.sentry.dev/oauth/authorize?response_type=code&client_id=abc${ESC}[39m${ESC}]8;;${BEL}`,
  '',
  'Waiting for authorization… (^C to cancel)',
  '',
  `${ESC}[1G${ESC}[0JOr paste the redirect URL here: ${ESC}[33G`,
].join('\n')

describe('parseMcpHelp', () => {
  it('claude:list/login/logout/--no-browser 都认出来,没有 --json', () => {
    const c = parseMcpHelp(CLAUDE_HELP + '\n' + CLAUDE_LOGIN_HELP)
    expect(c).toEqual({ mcp: true, list: true, login: true, logout: true, remove: true, json: false, noBrowser: true })
  })
  it('codex:有 --json,没有 --no-browser', () => {
    const c = parseMcpHelp(CODEX_HELP)
    expect(c).toMatchObject({ mcp: true, list: true, login: true, logout: true, json: true, noBrowser: false })
  })
  it('★不能被正文里的字骗到 —— 界面上摆一颗点了必然报错的授权按钮,比不摆更糟', () => {
    const help = `Usage: foo mcp [command]

Commands:
  list   List servers

Notes:
  You must login to your account before using remote servers.`
    expect(parseMcpHelp(help)).toMatchObject({ list: true, login: false })
  })
  it('压根没有 mcp 这个子命令(CLI 回一句 unknown command)', () => {
    expect(parseMcpHelp("error: unrecognized subcommand 'mcp'")).toEqual(NO_MCP)
    expect(parseMcpHelp('')).toEqual(NO_MCP)
  })
})

describe('parseClaudeList', () => {
  it('两种状态都解析对,健康检查那行不当成服务器', () => {
    expect(parseClaudeList(CLAUDE_LIST)).toEqual([
      { name: 'claude.ai Google Drive', target: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'connected', detail: '✔ Connected' },
      { name: 'probe-sentry', target: 'https://mcp.sentry.dev/mcp (HTTP)', auth: 'needs-auth', detail: '! Needs authentication' },
    ])
  })
  it('★名字里带空格照样是一个名字(claude.ai 的连接器就是这样)', () => {
    expect(parseClaudeList(CLAUDE_LIST)[0].name).toBe('claude.ai Google Drive')
  })
  it('★stdio 的命令行里自带 " - " —— 状态按最后一个切,不是第一个', () => {
    const [s] = parseClaudeList('mytool: node server.js - --port 3000 - ✔ Connected')
    expect(s.target).toBe('node server.js - --port 3000')
    expect(s.auth).toBe('connected')
  })
  it('一台都没配的时候不瞎造', () => {
    expect(parseClaudeList('No MCP servers configured. Use `claude mcp add` to add one.')).toEqual([])
  })
  it('项目级待批准', () => {
    expect(parseClaudeList('proj: ./x.js - ⏸ Pending approval')[0].auth).toBe('pending')
  })
  it('连不上', () => {
    expect(parseClaudeList('broken: http://127.0.0.1:1/mcp - ✘ Failed to connect')[0].auth).toBe('failed')
  })
})

describe('parseCodexList', () => {
  it('stdio 的标成 unsupported(它没有 OAuth 这回事),远程的按 auth_status 走', () => {
    const out = parseCodexList(CODEX_JSON)
    expect(out).toEqual([
      { name: 'omx_wiki', target: 'node /usr/local/lib/node_modules/oh-my-codex/dist/mcp/wiki-server.js', auth: 'unsupported', detail: 'unsupported' },
      { name: 'remote-thing', target: 'https://mcp.example.com/mcp', auth: 'needs-auth', detail: 'not_logged_in' },
    ])
  })
  it('★enabled:false 是「关着的」,不是「连上了」', () => {
    const out = parseCodexList(JSON.stringify([{ name: 'off', enabled: false, transport: { type: 'stdio', command: 'x' }, auth_status: 'ok' }]))
    // 原话也留着:关掉的和读不出状态的,在屏幕上不能长成一个样。
    expect(out[0]).toMatchObject({ auth: 'unknown', detail: 'disabled (ok)' })
  })
  it('不是 JSON / 不是数组 → 空,不抛', () => {
    expect(parseCodexList('boom')).toEqual([])
    expect(parseCodexList('{"a":1}')).toEqual([])
  })
})

describe('authFromText', () => {
  it('★「not authenticated」里含着「authenticated」—— 别判成已连接', () => {
    expect(authFromText('not authenticated')).toBe('needs-auth')
    expect(authFromText('Not logged in')).toBe('needs-auth')
  })
  it('★codex 说的是下划线体(not_logged_in)—— 不摊平的话它每一条都落成 unknown', () => {
    expect(authFromText('not_logged_in')).toBe('needs-auth')
    expect(authFromText('logged_in')).toBe('connected')
  })
  it('认不出来就是 unknown,不硬塞成 connected', () => {
    expect(authFromText('某种没见过的状态')).toBe('unknown')
  })
})

describe('extractAuthUrl', () => {
  it('★从真 pty 输出里抠出完整地址(URL 被 OSC 8 和颜色码切成好几段)', () => {
    expect(extractAuthUrl(PTY_LOGIN)).toBe('https://mcp.sentry.dev/oauth/authorize?response_type=code&client_id=abc')
  })
  it('没有地址就是 null', () => {
    expect(extractAuthUrl('Starting authentication…')).toBeNull()
  })
})

describe('loginOutcome / awaitingPaste', () => {
  it('★真实的失败原话(没有 pty 时 CLI 就回这句)', () => {
    const t = `Couldn't complete authentication for "probe-sentry": stdin isn't a terminal, so authentication can't be completed here.`
    expect(loginOutcome(t)).toBe('fail')
  })
  it('还在等的时候两个都不算数', () => {
    expect(loginOutcome('Waiting for authorization… (^C to cancel)')).toBeNull()
  })
  it('★等你粘地址那一刻要认出来 —— 认不出就只能干等着', () => {
    expect(awaitingPaste(PTY_LOGIN)).toBe(true)
    expect(awaitingPaste('Waiting for authorization…')).toBe(false)
  })
  it('成功', () => {
    expect(loginOutcome('Authentication successful for "probe-sentry"')).toBe('ok')
  })
})

describe('stripAnsi', () => {
  it('剥完只剩可见文本', () => {
    expect(stripAnsi(`${ESC}[94mhello${ESC}[39m`)).toBe('hello')
    expect(stripAnsi(`${ESC}]8;;https://x/${BEL}link${ESC}]8;;${BEL}`)).toBe('link')
  })
})
