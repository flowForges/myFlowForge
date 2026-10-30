import type { PluginManifest } from '../../kernel/pluginHost'

export const manifest: PluginManifest = {
  id: 'tools-registry',
  version: '0.1.0',
  kernel: '^0.1.0',
  provides: ['tools'],
  inject: ['permissionGate', 'approvals'],
}
