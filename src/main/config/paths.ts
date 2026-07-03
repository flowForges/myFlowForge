import { homedir } from 'node:os'
import { join } from 'node:path'

// Expand a leading `~` / `~/...` to the user's home dir. A workspace path typed as
// `~/work/...` would otherwise be taken literally — creating a real `~` directory
// relative to the process cwd and breaking every git/fs op on that workspace.
export function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

export const SYS_DIR = join(homedir(), '.myFlowForge')
export const sysFile = (name: string) => join(SYS_DIR, name)
export const reposDir = () => join(SYS_DIR, 'repos')
export const mirrorPath = (projectId: string) => join(reposDir(), `${projectId}.git`)

export const wsForgeDir = (wsPath: string) => join(wsPath, '.forge')
export const wsConfigFile = (wsPath: string) => join(wsForgeDir(wsPath), 'workspace.json')
export const wsRunsDir = (wsPath: string) => join(wsForgeDir(wsPath), 'runs')
export const wsRunDir = (wsPath: string, runId: string) => join(wsRunsDir(wsPath), runId)

export const pluginsFile = () => sysFile('integrations.json')
