import { describe, it, expect } from 'vitest'
import { BUILTIN_PROVIDERS, BUILTIN_IDS, getBuiltinProvider } from './providerCatalog'

describe('BUILTIN_PROVIDERS catalog', () => {
  it('has exactly the 12 expected ids in order', () => {
    expect(BUILTIN_IDS).toEqual(['claude', 'codex', 'gemini', 'qoder', 'cursor', 'opencode', 'qwen', 'copilot', 'pi', 'kimi', 'reasonix', 'trae', 'antigravity'])
  })

  it('every entry has non-empty metadata fields', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.id, `${p.id}.id`).toBeTruthy()
      expect(p.displayName, `${p.id}.displayName`).toBeTruthy()
      expect(p.defaultBin, `${p.id}.defaultBin`).toBeTruthy()
      expect(p.glyph, `${p.id}.glyph`).toBeTruthy()
      expect(p.brandBg, `${p.id}.brandBg`).toBeTruthy()
      expect(p.brandColor, `${p.id}.brandColor`).toBeTruthy()
      // opencode is a multi-provider gateway — models are dynamic (opencode models), no static defaults.
      if (p.id !== 'opencode') expect(p.defaultModels.length, `${p.id}.defaultModels`).toBeGreaterThan(0)
    }
  })

  it('every defaultModel entry has non-empty id and label', () => {
    for (const p of BUILTIN_PROVIDERS) {
      for (const m of p.defaultModels) {
        expect(m.id, `${p.id} model.id`).toBeTruthy()
        expect(m.label, `${p.id} model.label`).toBeTruthy()
      }
    }
  })

  describe('claude', () => {
    const p = getBuiltinProvider('claude')!
    it('has correct metadata', () => {
      expect(p.displayName).toBe('Claude Code')
      expect(p.defaultBin).toBe('claude')
      expect(p.glyph).toBe('◇')
      expect(p.brandBg).toBe('oklch(60% .14 35 / .18)')
      expect(p.brandColor).toBe('oklch(70% .15 35)')
    })
    it('defaultModels use stable CLI aliases (3 entries)', () => {
      expect(p.defaultModels).toEqual([
        { id: 'opus', label: 'opus', description: '最强推理 · 编排首选(始终最新)', contextWindow: 200_000 },
        { id: 'sonnet', label: 'sonnet', description: '均衡 · 高速执行(始终最新)', contextWindow: 200_000 },
        { id: 'haiku', label: 'haiku', description: '轻量 · 子任务批处理(始终最新)', contextWindow: 200_000 },
      ])
    })
  })

  describe('codex', () => {
    const p = getBuiltinProvider('codex')!
    it('has correct metadata', () => {
      expect(p.displayName).toBe('Codex')
      expect(p.defaultBin).toBe('codex')
      expect(p.glyph).toBe('⬡')
      expect(p.brandBg).toBe('oklch(70% .03 250 / .25)')
      expect(p.brandColor).toBe('oklch(78% .02 250)')
    })
    it('defaultModels match CODEX_MODELS verbatim (3 entries)', () => {
      expect(p.defaultModels).toEqual([
        { id: 'default', label: '账号默认', description: '用 codex 配置/账号的默认模型' },
        { id: 'gpt-5-codex', label: 'gpt-5-codex', description: '需 API key 登录' },
        { id: 'o4-mini', label: 'o4-mini', description: '需 API key 登录' },
      ])
    })
  })

  describe('gemini', () => {
    const p = getBuiltinProvider('gemini')!
    it('has correct metadata', () => {
      expect(p.displayName).toBe('Gemini CLI')
      expect(p.defaultBin).toBe('gemini')
      expect(p.glyph).toBe('✦')
      expect(p.brandBg).toBe('oklch(72% .15 235 / .2)')
      expect(p.brandColor).toBe('var(--accent)')
    })
    it('defaultModels match GEMINI_MODELS verbatim (2 entries)', () => {
      expect(p.defaultModels).toEqual([
        { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro', description: '长上下文', contextWindow: 1_048_576 },
        { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash', description: '高速', contextWindow: 1_048_576 },
      ])
    })
  })

  describe('qoder', () => {
    const p = getBuiltinProvider('qoder')!
    it('has correct metadata', () => {
      expect(p.displayName).toBe('Qoder')
      expect(p.defaultBin).toBe('qodercli')
      expect(p.glyph).toBe('◈')
      expect(p.brandBg).toBe('oklch(58% .22 300 / .2)')
      expect(p.brandColor).toBe('oklch(62% .2 300)')
    })
    it('defaultModels match QODER_MODELS verbatim (1 entry)', () => {
      expect(p.defaultModels).toEqual([
        { id: 'default', label: '账号默认' },
      ])
    })
  })

  describe('cursor', () => {
    const p = getBuiltinProvider('cursor')!
    it('has correct metadata', () => {
      expect(p.displayName).toBe('Cursor Agent')
      expect(p.defaultBin).toBe('cursor-agent')
      expect(p.glyph).toBe('▸')
      expect(p.brandBg).toBe('oklch(64% .15 300 / .2)')
      expect(p.brandColor).toBe('oklch(74% .12 300)')
    })
    it('defaultModels match CURSOR_MODELS verbatim (3 entries)', () => {
      expect(p.defaultModels).toEqual([
        { id: 'gpt-5', label: 'gpt-5' },
        { id: 'sonnet-4', label: 'sonnet-4' },
        { id: 'sonnet-4-thinking', label: 'sonnet-4-thinking' },
      ])
    })
  })
})

describe('providerCatalog install metadata', () => {
  it('every builtin has install + auth + help', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.installCmd.trim()).not.toBe('')
      expect(p.authCmd.trim()).not.toBe('')
      expect(p.installHelp.trim()).not.toBe('')
    }
  })
  it('claude carries the official install one-liner', () => {
    expect(getBuiltinProvider('claude')!.installCmd).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(getBuiltinProvider('gemini')!.installCmd).toBe('npm install -g @google/gemini-cli')
  })
})

describe('安装引导 · 2026-08-30 逐条实测过', () => {
  // 起因:用户报「首次安装引导给的 provider 安装命令不一定好使」。当晚把每一条都真的跑了一遍
  // (URL 发 HEAD、npm 包 `npm view`),下面这些断言钉的是那次核对的结论。
  it('每个内置 provider 都有安装命令、登录命令和一句说明 —— 三样缺一,引导就断在那儿', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.installCmd.trim(), p.id).not.toBe('')
      expect(p.authCmd.trim(), p.id).not.toBe('')
      expect(p.installHelp.trim(), p.id).not.toBe('')
    }
  })

  it('★antigravity 不许再指向那个 404 的安装脚本', () => {
    const agy = BUILTIN_PROVIDERS.find((p) => p.id === 'antigravity')!
    // `https://antigravity.google/install.sh` 实测回 404 —— 那条命令从来就跑不通。
    expect(agy.installCmd).not.toContain('install.sh')
  })

  it('★★备选命令只能是 npm,而且只给真的有官方包的那几个', () => {
    // npm 上的 `agy` / `antigravity` 是 0.0.0 的占位包。把它们写进引导 = 教用户全局装一个
    // 来路不明的东西,所以这条断言把「备选命令」限死在一份核过的名单里。
    const VERIFIED: Record<string, string> = {
      claude: 'npm install -g @anthropic-ai/claude-code',
      codex: 'npm install -g @openai/codex',
      opencode: 'npm install -g opencode-ai',
    }
    for (const p of BUILTIN_PROVIDERS) {
      if (!p.installAltCmd) continue
      expect(p.installAltCmd, p.id).toBe(VERIFIED[p.id])
    }
    // 名单里的那几个必须真的带上了 —— 否则这条断言会随着字段被删掉而静默变成空转
    for (const id of Object.keys(VERIFIED)) {
      expect(BUILTIN_PROVIDERS.find((p) => p.id === id)?.installAltCmd, id).toBe(VERIFIED[id])
    }
  })

  it('★指向 claude.ai / chatgpt.com 的那几条必须有备选 —— 国内不挂代理连不上', () => {
    for (const p of BUILTIN_PROVIDERS) {
      if (/claude\.ai|chatgpt\.com/.test(p.installCmd)) {
        expect(p.installAltCmd, `${p.id} 的安装命令要翻墙,必须给一条 npm 备选`).toBeTruthy()
      }
    }
  })
})
