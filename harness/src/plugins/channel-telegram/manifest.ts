import type { PluginManifest } from '../../kernel/pluginHost'

export const manifest: PluginManifest = {
  id: 'channel-telegram',
  version: '0.1.0',
  kernel: '^0.1.0',
  inject: ['sessions', 'approvals', 'sessionCommands', 'sandbox'],
}
