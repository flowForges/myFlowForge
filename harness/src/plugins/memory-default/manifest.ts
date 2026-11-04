import type { PluginManifest } from '../../kernel/pluginHost'

export const manifest: PluginManifest = { id: 'memory-default', version: '0.1.0', kernel: '^0.1.0', provides: ['memory'], inject: ['sessions'] }
