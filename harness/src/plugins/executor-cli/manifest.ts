import type { PluginManifest } from '../../kernel/pluginHost'

/** win32 内核不提供 pgids(inject 会一直等),只在 posix 声明 */
export function manifestFor(platform: NodeJS.Platform): PluginManifest {
  return {
    id: 'executor-cli',
    version: '0.1.0',
    kernel: '^0.1.0',
    provides: ['executors'],
    inject: ['tools', 'sessions', 'sandbox', 'permissionGate', ...(platform === 'win32' ? [] : ['pgids'])],
  }
}

export const manifest: PluginManifest = manifestFor(process.platform)
