// 标志块的着色类(--mffai-p-* 在 theme.css):执行器按 id,账号按预设 id;没有专属色的用中性的
export type Tint = 'cc' | 'cx' | 'gm'
export type PresetTint = 'anth' | 'oai' | 'ds' | 'or' | 'def'

export function execTint(id: string): Tint {
  if (id.startsWith('claude')) return 'cc'
  if (id.startsWith('gemini')) return 'gm'
  return 'cx'
}

export function presetTint(id: string): PresetTint {
  if (id === 'anthropic' || id === 'custom-anthropic') return 'anth'
  if (id === 'openai' || id === 'chatgpt' || id === 'custom-openai') return 'oai'
  if (id === 'deepseek') return 'ds'
  if (id === 'openrouter') return 'or'
  return 'def'
}
