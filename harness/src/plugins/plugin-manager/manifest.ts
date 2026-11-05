import type { PluginManifest } from '../../kernel/pluginHost'

/** win32 内核不提供 pgids(inject 会一直等到超时),只在 posix 声明,同 tools-coding */
export function manifestFor(platform: NodeJS.Platform): PluginManifest {
  return { id: 'plugin-manager', version: '0.1.0', kernel: '^0.1.0', inject: ['tools', 'sandbox', 'sessions', 'sessionCommands', ...(platform === 'win32' ? [] : ['pgids'])] }
}

export const manifest: PluginManifest = manifestFor(process.platform)
