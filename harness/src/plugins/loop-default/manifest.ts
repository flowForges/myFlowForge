import type { PluginManifest } from '../../kernel/pluginHost'

/** 不 inject `tools`:tools-registry 失败时仍要接管带 cwd 的会话并报 tools_unavailable(spec §8 接管条件) */
export const manifest: PluginManifest = { id: 'loop-default', version: '0.1.0', kernel: '^0.1.0', inject: ['sessions'] }
