// 测试夹具里同步地定一个仓库钉子:和 pinRepo 一样问 git,只是不用等
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { NO_REPO, pinFromPaths, type RepoPin } from '../src/lib/git/snapshot'

export function syncPin(cwd: string, env: NodeJS.ProcessEnv): RepoPin {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { cwd, env, encoding: 'utf8' })
  if (r.status !== 0) return NO_REPO
  const [top, gitDir, common] = r.stdout.split('\n')
  return pinFromPaths(top, gitDir, resolve(cwd, common))
}
