import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { DEFAULT_SYS_DIR_NAME, isValidSysDirName } from './sysDirName'

// Expand a leading `~` / `~/...` to the user's home dir. A workspace path typed as
// `~/work/...` would otherwise be taken literally — creating a real `~` directory
// relative to the process cwd and breaking every git/fs op on that workspace.
export function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

// Side-by-side test package: a build-time constant swaps the app data dir name. Unset or not a plain dot name
// -> .myFlowForge. The build already rejects bad names; this fallback is only a safety net.
declare const __MFF_SYS_DIR_NAME__: string | undefined
export function sysDirName(v: unknown): string {
  return isValidSysDirName(v) ? v : DEFAULT_SYS_DIR_NAME
}
export const SYS_DIR = join(homedir(), sysDirName(typeof __MFF_SYS_DIR_NAME__ === 'string' ? __MFF_SYS_DIR_NAME__ : undefined))
export const sysFile = (name: string) => join(SYS_DIR, name)
export const reposDir = () => join(SYS_DIR, 'repos')
export const mirrorPath = (projectId: string) => join(reposDir(), `${projectId}.git`)

export const wsForgeDir = (wsPath: string) => join(wsPath, '.forge')
export const wsConfigFile = (wsPath: string) => join(wsForgeDir(wsPath), 'workspace.json')
export const wsRunsDir = (wsPath: string) => join(wsForgeDir(wsPath), 'runs')
export const wsRunDir = (wsPath: string, runId: string) => join(wsRunsDir(wsPath), runId)

// #6: user-visible folder for technical-plan docs, e.g. <workspace>/myapp_docs/. Kept inside the
// workspace folder (not the hidden .forge/runs dir) so the user can open produced 技术方案 files.
export const wsDocsDir = (wsPath: string) => join(wsPath, `${basename(wsPath)}_docs`)

export const pluginsFile = () => sysFile('integrations.json')

// 宠物市场目录的离线缓存(codex-pets.net 拉不到时顶上)。纯缓存,删了只会退回「拉不到就空白」。
export const codexMarketCacheDir = () => sysFile('codex-market-cache')
