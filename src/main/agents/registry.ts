import type { AgentProvider, AgentTask, Model } from './types'
import { makeClaudeProvider } from './providers/claude'
import { makeCodexProvider } from './providers/codex'
import { makeGeminiProvider } from './providers/gemini'
import { makeQoderProvider } from './providers/qoder'
import { makeCursorProvider } from './providers/cursor'
import { makeOpencodeProvider } from './providers/opencode'
import { makeSubprocessProvider } from './providers/subprocess'
import { readAgentsConfig } from '../config/store'
import { BUILTIN_PROVIDERS } from '@shared/providerCatalog'

// Substitute {prompt} {model} {cwd} in a whitespace-separated args template.
function templateArgs(tmpl: string, task: AgentTask): string[] {
  return tmpl.trim().split(/\s+/).filter(Boolean).map(tok =>
    tok.replace('{prompt}', task.prompt).replace('{model}', task.model).replace('{cwd}', task.cwd))
}

type ProviderFactory = (spec: { bin: string; defaultModels: Model[] }) => AgentProvider
const FACTORIES: Record<string, ProviderFactory> = {
  claude: makeClaudeProvider,
  codex: makeCodexProvider,
  gemini: makeGeminiProvider,
  qoder: makeQoderProvider,
  cursor: makeCursorProvider,
  opencode: makeOpencodeProvider,
}

// Build the live provider registry from agents.json: built-ins (with optional bin overrides)
// plus any user-added custom agents. A getter so it can be rebuilt when the config changes.
export function buildProviderRegistry(): Record<string, AgentProvider> {
  const cfg = readAgentsConfig()
  const binOf = (id: string, def: string) => cfg.providers.find(p => p.id === id)?.binOverride?.trim() || def
  const reg: Record<string, AgentProvider> = {}
  for (const meta of BUILTIN_PROVIDERS) {
    reg[meta.id] = FACTORIES[meta.id]({ bin: binOf(meta.id, meta.defaultBin), defaultModels: meta.defaultModels as Model[] })
  }
  for (const c of cfg.custom) {
    if (!c.id || !c.bin || reg[c.id]) continue
    reg[c.id] = makeSubprocessProvider({
      id: c.id, displayName: c.displayName || c.id, bin: c.bin,
      buildArgs: (task) => templateArgs(c.argsTemplate, task),
      models: c.models.length ? c.models : [{ id: 'default', label: 'default' }],
    })
  }
  return reg
}

// Rebuild registry contents in place so every holder (orchestrator, ipc handlers) that
// shares this object reference sees the new providers without re-wiring.
export function rebuildProviderRegistry(reg: Record<string, AgentProvider>): Record<string, AgentProvider> {
  const fresh = buildProviderRegistry()
  for (const k of Object.keys(reg)) delete reg[k]
  Object.assign(reg, fresh)
  return reg
}
