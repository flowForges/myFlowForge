import type { ModelInfo } from './types'

export interface BuiltinProviderMeta {
  id: string
  displayName: string
  defaultBin: string
  glyph: string
  brandBg: string
  brandColor: string
  defaultModels: ModelInfo[]
  installCmd: string
  authCmd: string
  installHelp: string
}

// Single source-of-truth for the 5 built-in coding-agent providers.
// Values copied verbatim from their original homes:
//   displayName + defaultBin  → src/main/agents/registry.ts (binOf defaults) +
//                               src/renderer/settings/AgentsPane.tsx BUILTINS
//   brandBg + brandColor      → src/renderer/shell/StatusBar.tsx BRAND map (bg/color per id)
//   glyph                     → src/renderer/views/chat/Composer.tsx AGENT_LOGOS glyph
//                               (qoder/cursor were FALLBACK '◆'; assigned distinct glyphs here)
//   defaultModels             → src/main/agents/providers/{claude,codex,gemini,qoder,cursor}.ts *_MODELS
export const BUILTIN_PROVIDERS: BuiltinProviderMeta[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    defaultBin: 'claude',
    glyph: '◇',
    brandBg: 'oklch(60% .14 35 / .18)',
    brandColor: 'oklch(70% .15 35)',
    defaultModels: [
      { id: 'opus', label: 'opus', description: '最强推理 · 编排首选(始终最新)', contextWindow: 200_000 },
      { id: 'sonnet', label: 'sonnet', description: '均衡 · 高速执行(始终最新)', contextWindow: 200_000 },
      { id: 'haiku', label: 'haiku', description: '轻量 · 子任务批处理(始终最新)', contextWindow: 200_000 },
    ],
    installCmd: 'curl -fsSL https://claude.ai/install.sh | bash',
    authCmd: 'claude',
    installHelp: '安装后运行 claude，按浏览器提示登录 Claude Code。',
  },
  {
    id: 'codex',
    displayName: 'Codex',
    defaultBin: 'codex',
    glyph: '⬡',
    brandBg: 'oklch(70% .03 250 / .25)',
    brandColor: 'oklch(78% .02 250)',
    defaultModels: [
      { id: 'default', label: '账号默认', description: '用 codex 配置/账号的默认模型' },
      { id: 'gpt-5-codex', label: 'gpt-5-codex', description: '需 API key 登录' },
      { id: 'o4-mini', label: 'o4-mini', description: '需 API key 登录' },
    ],
    installCmd: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    authCmd: 'codex',
    installHelp: '运行 codex 后选择 Sign in with ChatGPT，或按团队要求配置 API key。',
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    defaultBin: 'gemini',
    glyph: '✦',
    brandBg: 'oklch(72% .15 235 / .2)',
    brandColor: 'var(--accent)',
    defaultModels: [
      { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro', description: '长上下文', contextWindow: 1_048_576 },
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash', description: '高速', contextWindow: 1_048_576 },
    ],
    installCmd: 'npm install -g @google/gemini-cli',
    authCmd: 'gemini',
    installHelp: '运行 gemini 后选择 Google OAuth；也可设置 GEMINI_API_KEY 后启动。',
  },
  {
    id: 'qoder',
    displayName: 'Qoder',
    defaultBin: 'qodercli',
    glyph: '◈',
    brandBg: 'oklch(58% .22 300 / .2)',
    brandColor: 'oklch(62% .2 300)',
    defaultModels: [
      { id: 'default', label: '账号默认' },
    ],
    installCmd: '按 Qoder 官方下载页安装 qodercli',
    authCmd: 'qodercli login',
    installHelp: '安装后运行 qodercli login 登录，然后在设置里重新检测。',
  },
  {
    id: 'cursor',
    displayName: 'Cursor Agent',
    defaultBin: 'cursor-agent',
    glyph: '▸',
    brandBg: 'oklch(64% .15 300 / .2)',
    brandColor: 'oklch(74% .12 300)',
    defaultModels: [
      { id: 'gpt-5', label: 'gpt-5' },
      { id: 'sonnet-4', label: 'sonnet-4' },
      { id: 'sonnet-4-thinking', label: 'sonnet-4-thinking' },
    ],
    installCmd: '按 Cursor 官方文档启用 Agent CLI',
    authCmd: 'cursor-agent login',
    installHelp: '如果团队使用 Cursor Agent，把可执行路径填入设置后重新检测。',
  },
  {
    id: 'opencode',
    displayName: 'opencode',
    defaultBin: 'opencode',
    glyph: '◉',
    brandBg: 'oklch(62% .03 60 / .18)',
    brandColor: 'oklch(68% .04 60)',
    // opencode is a multi-provider gateway — its real model list comes from `opencode models`
    // (liveModels), so no static defaults are hardcoded (they'd differ per configured provider).
    defaultModels: [],
    installCmd: 'curl -fsSL https://opencode.ai/install | bash',
    authCmd: 'opencode auth login',
    installHelp: '安装后运行 opencode auth login 配置模型 provider（一次接入多家模型）。模型列表由 opencode models 动态获取。',
  },
  {
    id: 'qwen',
    displayName: 'Qwen Code',
    defaultBin: 'qwen',
    glyph: '◎',
    brandBg: 'oklch(58% .2 300 / .2)',
    brandColor: 'oklch(66% .18 300)',
    // Qwen Code 是 gemini-cli 的 fork（阿里，面向 Qwen3-Coder）。无头调用与 gemini 同款：qwen -m <model> -p <prompt>。
    defaultModels: [
      { id: 'qwen3-coder-plus', label: 'qwen3-coder-plus', description: '编码主力' },
      { id: 'qwen3-coder-flash', label: 'qwen3-coder-flash', description: '高速' },
    ],
    installCmd: 'npm install -g @qwen-code/qwen-code',
    authCmd: 'qwen',
    installHelp: '安装后运行 qwen 按提示用 Qwen OAuth 登录，或设置 DASHSCOPE_API_KEY / OPENAI_API_KEY 后启动。',
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    defaultBin: 'copilot',
    glyph: '❉',
    brandBg: 'oklch(55% .02 250 / .28)',
    brandColor: 'oklch(80% .02 250)',
    // 指新的 agentic「copilot」命令（不是 gh copilot suggest/explain）。无头:copilot -p <prompt> --allow-all-tools。
    defaultModels: [
      { id: 'default', label: '账号默认', description: '用 copilot 配置的默认模型' },
      { id: 'claude-sonnet-4.5', label: 'claude-sonnet-4.5' },
      { id: 'gpt-5', label: 'gpt-5' },
    ],
    installCmd: 'npm install -g @github/copilot',
    authCmd: 'copilot',
    installHelp: '需 GitHub Copilot 订阅。安装后运行 copilot，在其中用 /login 登录 GitHub 账号。',
  },
]

// Lookup helpers
export const BUILTIN_IDS = BUILTIN_PROVIDERS.map(p => p.id)
export function getBuiltinProvider(id: string): BuiltinProviderMeta | undefined {
  return BUILTIN_PROVIDERS.find(p => p.id === id)
}

// 当某模型未带 contextWindow 时的 per-provider 回退窗口（保守近似；真实值以流式 usage 为准）。
export const PROVIDER_DEFAULT_WINDOW: Record<string, number> = {
  claude: 200_000,
  codex: 128_000,
  cursor: 200_000,
  gemini: 1_048_576,
  qoder: 200_000,
  opencode: 200_000,
  qwen: 256_000,
  copilot: 128_000,
}
