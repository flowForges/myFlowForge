import { execa } from 'execa'

export function buildGitEnv(proxy: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (proxy && proxy.trim()) {
    const p = proxy.trim()
    env.HTTP_PROXY = p; env.HTTPS_PROXY = p; env.ALL_PROXY = p
    env.http_proxy = p; env.https_proxy = p; env.all_proxy = p
    const existingNoProxy = env.NO_PROXY || env.no_proxy || ''
    const noProxy = existingNoProxy ? `${existingNoProxy},localhost,127.0.0.1` : 'localhost,127.0.0.1'
    env.NO_PROXY = noProxy; env.no_proxy = noProxy
  }
  return env
}

export interface GitOpts { cwd: string; proxy?: string }

export async function git(args: string[], opts: GitOpts): Promise<string> {
  // core.quotePath=false → git outputs real UTF-8 paths instead of octal-escaped, quoted
  // strings for non-ASCII filenames (e.g. Chinese), so the file tree/changes show正常文件名.
  const { stdout } = await execa('git', ['-c', 'core.quotePath=false', ...args], { cwd: opts.cwd, env: buildGitEnv(opts.proxy ?? '') })
  return stdout
}
