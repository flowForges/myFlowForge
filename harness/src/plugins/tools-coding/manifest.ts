import type { PluginManifest } from '../../kernel/pluginHost'

/**
 * permissionGate:grep / glob 逐个文件过门(cwd = 家目录时不碰 ~/.ssh),write / edit / apply_patch 写前再查一次;
 * sandbox:shell 的执行计划(没有就不激活,绝不无沙箱跑命令);
 * pgids:shell 进程组登记(崩溃后收孤儿)。win32 内核不提供 pgids(inject 会一直等),只在 posix 声明
 */
export function manifestFor(platform: NodeJS.Platform): PluginManifest {
  return { id: 'tools-coding', version: '0.1.0', kernel: '^0.1.0', inject: ['tools', 'permissionGate', 'sandbox', ...(platform === 'win32' ? [] : ['pgids'])] }
}

export const manifest: PluginManifest = manifestFor(process.platform)
