import { describe, it, expect } from 'vitest'
import {
  CLAUDE_CONTROL_FLAGS, controlInitLine, userMessageLine,
  parseCanUseTool, toolTarget, controlAllowLine, controlDenyLine,
  parseAskQuestions, controlAnswerLine, askGateTitle, gateTitle,
  unhandledControlRequest, controlErrorLine,
} from './claudeControl'

// 真机抓来的 AskUserQuestion can_use_tool 载荷(claude 2.1.225),裁掉无关字段。
const ASK_INPUT = {
  questions: [{
    question: 'CLI 工具的配置文件应该用哪种格式？',
    header: '配置格式',
    options: [
      { label: 'JSON', description: '通用性最好，但不支持注释' },
      { label: 'YAML', description: '可读性强，但缩进敏感' },
      { label: 'TOML', description: '语法清晰简洁' },
    ],
    multiSelect: false,
  }],
}

describe('claudeControl', () => {
  it('exposes the two control flags in one array', () => {
    expect(CLAUDE_CONTROL_FLAGS).toEqual(['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'])
  })

  it('frames an initialize control_request', () => {
    expect(JSON.parse(controlInitLine())).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
  })

  it('frames the prompt as a user message', () => {
    const o = JSON.parse(userMessageLine('do the thing'))
    expect(o).toMatchObject({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] }, parent_tool_use_id: null })
  })

  it('parses a can_use_tool request (main agent → no agentId)', () => {
    const req = parseCanUseTool({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } })
    expect(req).toEqual({ requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_1', agentId: undefined, requiresUserInteraction: false })
  })

  it('parses a sub-agent can_use_tool request (agentId set)', () => {
    const req = parseCanUseTool({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/x' }, tool_use_id: 'toolu_2', agent_id: 'a99' } })
    expect(req?.agentId).toBe('a99')
  })

  it('returns null for non-can_use_tool objects', () => {
    expect(parseCanUseTool({ type: 'assistant' })).toBeNull()
    expect(parseCanUseTool({ type: 'control_request', request: { subtype: 'initialize' } })).toBeNull()
    expect(parseCanUseTool(null)).toBeNull()
  })

  it('extracts a human target from tool input', () => {
    expect(toolTarget({ file_path: '/a/b' })).toBe('/a/b')
    expect(toolTarget({ command: 'rm -rf x' })).toBe('rm -rf x')
    expect(toolTarget({ path: '/p' })).toBe('/p')
    expect(toolTarget({})).toBeUndefined()
  })

  // ★★浏览器工具(mcp__claude-in-chrome__navigate)的输入里**只有** url。少了这条,用户要授权
  //  agent 在自己已登录的浏览器里动手时,门上是一行工具名加一个空的 where —— 看不到动的是哪个站点。
  it('★浏览器/网页类工具的 url 也算目标 —— 否则 navigate 的门上一个字的目标都没有', () => {
    expect(toolTarget({ url: 'https://example.com/checkout' })).toBe('https://example.com/checkout')
    // 同时有命令和 url 时,命令才是要判断的东西(顺序不许反)。
    expect(toolTarget({ command: 'curl x', url: 'https://example.com' })).toBe('curl x')
  })

  // ★★门的 where 现在是「解析后的规范化 URL」,不是压完空白的原串:原样渲染 userinfo 会把攻击者
  //  随手写的那截当成「看起来像的站点」给用户看,`https://bank.example\n\n\n\n\n\n@evil.com/x`
  //  真正去的是 evil.com(WHATWG URL 把换行整个删掉再解析),门上也必须说 evil.com。
  it('★url 里的换行/制表是伪装,不是排版 —— 解析后给的是 CLI 真正去的那个 host(evil.com),不是userinfo', () => {
    const w = toolTarget({ url: 'https://bank.example\n\n\n\n\n\n@evil.com/x' })!
    expect(w).toBe('https://evil.com/x')
    expect(w).not.toMatch(/[\n\t]/)
    expect(toolTarget({ url: '  https://a.example\t\t@evil.com  ' })).toBe('https://evil.com/')
  })

  // ★★设计要点:门上不许再出现 userinfo、同形字、或把真实 host 挤出滚动折叠线以下的超长串。
  it('★userinfo 伪装:`https://bank.example@evil.com/` 门上要说 evil.com,不是 bank.example', () => {
    expect(toolTarget({ url: 'https://bank.example@evil.com/' })).toBe('https://evil.com/')
  })

  it('★同形字攻击:西里尔 аррӏе.com 要转成 punycode,不能肉眼看着像 apple.com', () => {
    const w = toolTarget({ url: 'https://аррӏе.com/login' })!
    expect(w).toBe('https://xn--80ak6aa92e.com/login')
    expect(w).toMatch(/^https:\/\/xn--/)
  })

  it('★超长 path 要截断,但 host 必须留在开头且不被挤到折叠线以下', () => {
    const longPath = 'https://example.com/' + 'a'.repeat(500)
    const w = toolTarget({ url: longPath })!
    expect(w.startsWith('https://example.com/')).toBe(true)
    expect(w.length).toBeLessThanOrEqual(200)
  })

  it('解析不了的 url(没有合法 scheme/authority 的相对路径)——退回压平后的原串,不装作认得它', () => {
    expect(toolTarget({ url: 'not a url ::: at all' })).toBe('not a url ::: at all')
    expect(toolTarget({ url: 'relative/path' })).toBe('relative/path')
  })

  it('command 的换行**不压**:多行 Bash 在门上保留换行是对的(回归保护)', () => {
    expect(toolTarget({ command: 'echo a\necho b' })).toBe('echo a\necho b')
  })

  it('frames an allow response echoing input + request_id', () => {
    const req = { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_1' }
    const o = JSON.parse(controlAllowLine(req))
    expect(o).toMatchObject({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'toolu_1' } } })
  })

  it('frames a deny response with a message', () => {
    const req = { requestId: 'r1', toolName: 'Bash', input: {}, toolUseId: 'toolu_1' }
    const o = JSON.parse(controlDenyLine(req, '不行'))
    expect(o).toMatchObject({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: '不行', toolUseID: 'toolu_1' } } })
  })

  it('surfaces requires_user_interaction so a question is not mistaken for a permission', () => {
    const req = parseCanUseTool({ type: 'control_request', request_id: 'r3', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: ASK_INPUT, tool_use_id: 'toolu_3', requires_user_interaction: true } })
    expect(req?.requiresUserInteraction).toBe(true)
    // A plain permission request carries no such flag.
    expect(parseCanUseTool({ type: 'control_request', request_id: 'r4', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })?.requiresUserInteraction).toBe(false)
  })

  describe('parseAskQuestions', () => {
    it('lifts the questions + options out of a real AskUserQuestion input', () => {
      expect(parseAskQuestions(ASK_INPUT)).toEqual([{
        question: 'CLI 工具的配置文件应该用哪种格式？',
        header: '配置格式',
        multiSelect: false,
        options: [
          { label: 'JSON', description: '通用性最好，但不支持注释' },
          { label: 'YAML', description: '可读性强，但缩进敏感' },
          { label: 'TOML', description: '语法清晰简洁' },
        ],
      }])
    })

    it('keeps multiSelect and tolerates a missing description/header', () => {
      const qs = parseAskQuestions({ questions: [{ question: '选哪几个？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] })
      expect(qs).toEqual([{ question: '选哪几个？', header: undefined, multiSelect: true, options: [{ label: 'A', description: undefined }, { label: 'B', description: undefined }] }])
    })

    it('returns null for anything that is not a well-formed question set', () => {
      expect(parseAskQuestions({ command: 'ls' })).toBeNull()          // a normal tool's input
      expect(parseAskQuestions(null)).toBeNull()
      expect(parseAskQuestions({ questions: [] })).toBeNull()          // nothing to ask
      expect(parseAskQuestions({ questions: 'nope' })).toBeNull()
      expect(parseAskQuestions({ questions: [{ question: 'q', options: [] }] })).toBeNull()          // no option to click
      expect(parseAskQuestions({ questions: [{ question: '', options: [{ label: 'A' }] }] })).toBeNull()
      expect(parseAskQuestions({ questions: [{ question: 'q', options: [{ description: '无 label' }] }] })).toBeNull()
    })
  })

  describe('controlAnswerLine', () => {
    const req = { requestId: 'r9', toolName: 'AskUserQuestion', input: ASK_INPUT, toolUseId: 'toolu_9' }

    it('carries the choice back inside updatedInput.answers (the CLI reads it from there)', () => {
      const o = JSON.parse(controlAnswerLine(req, { 'CLI 工具的配置文件应该用哪种格式？': ['TOML'] }))
      expect(o.response.response.behavior).toBe('allow')
      // Single-select answers are a bare label string, keyed by the question's own text.
      expect(o.response.response.updatedInput.answers).toEqual({ 'CLI 工具的配置文件应该用哪种格式？': 'TOML' })
      // The questions must survive alongside the answers — the CLI re-reads them to build the tool_result.
      expect(o.response.response.updatedInput.questions).toEqual(ASK_INPUT.questions)
      expect(o.response.response.toolUseID).toBe('toolu_9')
    })

    it('sends a multiSelect answer as an array of labels', () => {
      const multi = { requestId: 'r9', toolName: 'AskUserQuestion', input: { questions: [{ question: '要哪几个？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] } }
      const o = JSON.parse(controlAnswerLine(multi, { '要哪几个？': ['A', 'B'] }))
      expect(o.response.response.updatedInput.answers).toEqual({ '要哪几个？': ['A', 'B'] })
    })

    it('drops empty answers instead of sending a blank pick', () => {
      const o = JSON.parse(controlAnswerLine(req, { 'CLI 工具的配置文件应该用哪种格式？': [] }))
      expect(o.response.response.updatedInput.answers).toEqual({})
    })

    it('sends free text as `response` — the escape hatch when no option fits', () => {
      const o = JSON.parse(controlAnswerLine(req, {}, '都不合适，我要用 INI'))
      expect(o.response.response.updatedInput.response).toBe('都不合适，我要用 INI')
    })

    it('omits `response` when the user only clicked options', () => {
      const o = JSON.parse(controlAnswerLine(req, { 'CLI 工具的配置文件应该用哪种格式？': ['JSON'] }, '   '))
      expect(o.response.response.updatedInput).not.toHaveProperty('response')
    })
  })

  describe('askGateTitle', () => {
    it('uses the question itself as the card title when there is only one', () => {
      expect(askGateTitle(parseAskQuestions(ASK_INPUT)!)).toBe('CLI 工具的配置文件应该用哪种格式？')
    })
    it('falls back to a generic title for a multi-question set', () => {
      const qs = parseAskQuestions({ questions: [{ question: 'a', options: [{ label: 'x' }] }, { question: 'b', options: [{ label: 'y' }] }] })!
      expect(askGateTitle(qs)).toBe('请回答以下问题')
    })
  })
})

/**
 * 和 codex 那个「回答形状错了就永远悬着」是同一类问题(见 commit 4c6423e)。
 *
 * claude 在 `--input-format stream-json --permission-prompt-tool stdio` 下会发 control_request
 * 等我们回 control_response。我们只认 `can_use_tool` —— 其余子类型(装好的 CLI 里还有
 * `hook_callback` / `mcp_message`)会一路掉到底、**永远没人回答**,于是那一轮静静地挂住。
 *
 * ★真发不发取决于我们有没有启用那些能力,但「不认识就不回答」本身就是个不该存在的形状:
 *  宁可明确回一句「我不支持」,也不能让对面干等。
 */
describe('unhandledControlRequest —— 不认识的控制请求也必须有人回答', () => {
  it('can_use_tool 不算(它有正经的处理路径)', () => {
    expect(unhandledControlRequest({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool' } })).toBeNull()
  })

  it('★其它子类型要被认出来,并带上 request_id —— 没有它就无法回答', () => {
    expect(unhandledControlRequest({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } }))
      .toEqual({ requestId: 'r2', subtype: 'hook_callback' })
    expect(unhandledControlRequest({ type: 'control_request', request_id: 'r3', request: { subtype: 'mcp_message' } }))
      .toEqual({ requestId: 'r3', subtype: 'mcp_message' })
  })

  it('★不是 control_request 的一概不碰 —— 普通消息流不能被误当成待回答的请求', () => {
    expect(unhandledControlRequest({ type: 'assistant', message: {} })).toBeNull()
    expect(unhandledControlRequest({ type: 'control_response', response: {} })).toBeNull()
    // control_cancel_request 是「撤销」,不是等回答的请求,回它反而错。
    expect(unhandledControlRequest({ type: 'control_cancel_request', request_id: 'r4' })).toBeNull()
    expect(unhandledControlRequest(null)).toBeNull()
  })

  it('没有 request_id 就没法回答,只能放过(回了也没人认领)', () => {
    expect(unhandledControlRequest({ type: 'control_request', request: { subtype: 'hook_callback' } })).toBeNull()
  })
})

describe('gateTitle —— 门上的那行标题', () => {
  it('普通工具一个字不变(回归保护)', () => {
    expect(gateTitle('Bash')).toBe('Bash 请求执行')
    expect(gateTitle('Write')).toBe('Write 请求执行')
  })
  // ★★用户正要决定「让不让 agent 在我已登录的浏览器里动手」,此时最不该给他看的就是 MCP 原始工具名。
  it('★浏览器工具翻成人话,不把 mcp__claude-in-chrome__ 糊在门上', () => {
    expect(gateTitle('mcp__claude-in-chrome__navigate')).toBe('浏览器 · 打开页面 请求执行')
    expect(gateTitle('mcp__claude-in-chrome__form_input')).toBe('浏览器 · 填表单 请求执行')
    expect(gateTitle('mcp__claude-in-chrome__navigate')).not.toContain('mcp__')
  })
})

describe('controlErrorLine', () => {
  it('按控制协议回一个 error 响应,带上原 request_id', () => {
    const line = JSON.parse(controlErrorLine('r9', 'not supported'))
    expect(line.type).toBe('control_response')
    expect(line.response.subtype).toBe('error')
    expect(line.response.request_id).toBe('r9')
    expect(line.response.error).toContain('not supported')
  })
})
