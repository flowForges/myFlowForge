import type { PluginManifest } from '../../kernel/pluginHost'

/** permissionGate:grep / glob 逐个文件过门(cwd = 家目录时不碰 ~/.ssh),write / edit / apply_patch 写前再查一次 */
export const manifest: PluginManifest = { id: 'tools-coding', version: '0.1.0', kernel: '^0.1.0', inject: ['tools', 'permissionGate'] }
