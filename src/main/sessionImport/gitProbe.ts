import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GitRepoCandidate } from '@shared/types'

export function probeGitRepo(
  cwd: string,
  deps: { exists?: (p: string) => boolean; run?: (args: string[], cwd: string) => string } = {},
): GitRepoCandidate | null {
  const exists = deps.exists ?? existsSync
  if (!exists(join(cwd, '.git'))) return null
  const run = deps.run ?? ((args, c) => execFileSync('git', ['-C', c, ...args], { encoding: 'utf8', timeout: 3000 }))
  let repoUrl: string | null = null
  try { const u = run(['remote', 'get-url', 'origin'], cwd).trim(); repoUrl = u || null } catch { repoUrl = null }
  let branch = 'main'
  try { const b = run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim(); if (b) branch = b } catch { /* default main */ }
  return { cwd, repoUrl, branch }
}
