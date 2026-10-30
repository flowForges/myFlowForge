// tools-coding:编码工具 read / list / glob / grep / write / edit / apply_patch / shell(spec §7),注册到 tools 服务
import type { PermissionGate } from '../../kernel/permissionGate'
import type { Plugin } from '../../kernel/pluginHost'
import type { ToolsService } from '../../lib/tools/types'
import { applyPatchTool } from './applyPatchTool'
import { editTool } from './edit'
import type { GitRunner } from './files'
import { globTool } from './glob'
import { grepTool } from './grep'
import { listTool } from './list'
import { manifest } from './manifest'
import { readTool } from './read'
import { shellTool } from './shell'
import { writeTool } from './write'

export type { GitRunner }

export interface ToolsCodingOpts {
  /** 测试注入隔离环境的 git */
  git?: GitRunner
  /** grep 线程超时,默认 30 s */
  grepTimeoutMs?: number
  /** shell 的基础环境(按白名单过滤);默认 process.env,测试注入隔离环境 */
  shellEnv?: NodeJS.ProcessEnv
  /** 登录 shell 的 PATH;默认探测一次,测试注入 `async () => ''` */
  loginPath?: () => Promise<string>
  /** shell timeoutMs 下限,默认 1 s */
  minTimeoutMs?: number
}

export function createToolsCoding(opts: ToolsCodingOpts = {}): Plugin {
  return {
    manifest,
    activate(ctx) {
      const tools = ctx.services.get<ToolsService>('tools')
      const gate = ctx.services.get<PermissionGate>('permissionGate')
      if (!tools || !gate) throw new Error('tools / permissionGate service missing')
      const deps = { gate, git: opts.git, grepTimeoutMs: opts.grepTimeoutMs }
      const shell = shellTool({ env: opts.shellEnv, loginPath: opts.loginPath, minTimeoutMs: opts.minTimeoutMs })
      for (const t of [readTool(), listTool(), globTool(deps), grepTool(deps), writeTool(deps), editTool(deps), applyPatchTool(deps), shell]) ctx.effect(tools.register(t))
    },
  }
}

export default createToolsCoding()
