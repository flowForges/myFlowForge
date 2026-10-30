// tools-coding:编码工具 read / list / glob / grep / write / edit(spec §7),注册到 tools 服务
import type { PermissionGate } from '../../kernel/permissionGate'
import type { Plugin } from '../../kernel/pluginHost'
import type { ToolsService } from '../../lib/tools/types'
import { editTool } from './edit'
import type { GitRunner } from './files'
import { globTool } from './glob'
import { grepTool } from './grep'
import { listTool } from './list'
import { manifest } from './manifest'
import { readTool } from './read'
import { writeTool } from './write'

export type { GitRunner }

export interface ToolsCodingOpts {
  /** 测试注入隔离环境的 git */
  git?: GitRunner
  /** grep 线程超时,默认 30 s */
  grepTimeoutMs?: number
}

export function createToolsCoding(opts: ToolsCodingOpts = {}): Plugin {
  return {
    manifest,
    activate(ctx) {
      const tools = ctx.services.get<ToolsService>('tools')
      const gate = ctx.services.get<PermissionGate>('permissionGate')
      if (!tools || !gate) throw new Error('tools / permissionGate service missing')
      const deps = { gate, git: opts.git, grepTimeoutMs: opts.grepTimeoutMs }
      for (const t of [readTool(), listTool(), globTool(deps), grepTool(deps), writeTool(deps), editTool(deps)]) ctx.effect(tools.register(t))
    },
  }
}

export default createToolsCoding()
