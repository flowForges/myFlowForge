import { execa } from 'execa'

export function buildGitEnv(proxy: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // We spawn git non-interactively from the Electron main process (no TTY). For an SSH remote
  // whose host isn't in ~/.ssh/known_hosts yet, ssh can't show its "continue connecting? (yes/no)"
  // prompt and aborts with "Host key verification failed" → clone fails. `accept-new` does the
  // trust-on-first-use write for us (like the user typing yes) while still REJECTING a changed key
  // for an already-known host (MITM guard) — safer than StrictHostKeyChecking=no. Requires OpenSSH
  // ≥7.6 (macOS built-in and Git-for-Windows both satisfy this). Never override a user's own setting.
  if (!env.GIT_SSH_COMMAND) {
    env.GIT_SSH_COMMAND = 'ssh -o StrictHostKeyChecking=accept-new'
  }
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
