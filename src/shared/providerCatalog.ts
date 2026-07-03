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
}
