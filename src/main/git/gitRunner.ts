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
  } else {
    // 「留空 = 直连」必须是字面的,和 agents/env.ts 的 buildAgentEnv 保持同一套语义。app 继承整个
    // 启动环境,上面很可能已经带着一个用户在「终端代理」里看不见、也清不掉的 HTTP(S)_PROXY。不剥掉的话
    // 就会出现:清空设置后 agent 确实直连了,而 git clone/fetch 仍在走那个看不见的代理 —— 同一个坑
    // 只补了一半,而且 git 的失败(超时/证书错)比 agent 的 403 更难联想到代理头上。
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k]
  }
  return env
}

// `signal` lets a long clone/fetch be aborted (user cancels workspace creation): execa kills the git
// child when the signal fires, and the awaited call rejects with an AbortError. execa v9 renamed the
// option `signal` → `cancelSignal`; passing the old name throws a TypeError, so we map it here.
export interface GitOpts { cwd: string; proxy?: string; signal?: AbortSignal }

export async function git(args: string[], opts: GitOpts): Promise<string> {
  // core.quotePath=false → git outputs real UTF-8 paths instead of octal-escaped, quoted
  // strings for non-ASCII filenames (e.g. Chinese), so the file tree/changes show正常文件名.
  const { stdout } = await execa('git', ['-c', 'core.quotePath=false', ...args], { cwd: opts.cwd, env: buildGitEnv(opts.proxy ?? ''), cancelSignal: opts.signal })
  return stdout
}
