import type { PluginManifest } from '../../kernel/pluginHost'

export const manifest: PluginManifest = { id: 'model-anthropic', version: '0.1.0', kernel: '^0.1.0', inject: ['models'] }
