/**
 * 「这条命令要不要问人」—— PATH shim 的策略表。
 *
 * ★★背景:claude / codex 有自己的审批协议,gemini / qwen 有 hook,而 **qoder / cursor /
 *  opencode / copilot 三样都没有**,只支持「全放行」。对它们来说,把 Forge 自己的目录放到 PATH 最前面、
 *  在命令真正执行前问一次,是**唯一**能把授权收回 app 里的办法。
 *  (用户 2026-09-07 原话:「qoder等都得支持上啊,这个很重要,要授权,你不弹,用户不知道,
 *   provider 也不知道有没有执行完,这种太诡异了」。)
 *
 * ★★判据是**可逆性**,不是「危险」:文件改动发生在 git worktree 里,回滚得掉;
 *  而 `git push` / `rm -rf` / 打生产的请求 / 部署命令回滚不掉。**只拦不可逆的那一半。**
 * ★★拦得太宽和不拦一样糟:`git status` 一轮跑十几次,每次弹一下用户会直接切回完全访问档,
 *  于是一个都拦不住。所以下面每条规则都尽量收窄到「真正不可逆的那个子命令 / 那个参数」。
 *
 * 这份是纯逻辑,没有 I/O —— shim 只负责问,判断全在主进程这边(方便测,也方便以后让用户改)。
 */

export interface AuthNeed {
  /** 卡片标题,例如 `git push`。 */
  title: string
  /** 给**人**看的一句话:为什么这条要问。 */
  reason: string
}

/** 会被放进 shim 目录的命令。不在这张表里的命令根本不经过我们。 */
export const SHIMMED_COMMANDS = [
  'git', 'rm', 'sudo', 'ssh', 'scp', 'rsync',
  'npm', 'pnpm', 'yarn', 'kubectl', 'docker', 'helm', 'terraform', 'aws', 'gcloud',
] as const

const has = (argv: string[], ...flags: string[]) => argv.some(a => flags.includes(a))
/** 第一个不以 `-` 开头的参数 = 子命令。`git -C x push` 里的 push 靠它拿到。 */
const sub = (argv: string[]): string => argv.find(a => !a.startsWith('-')) ?? ''

const need = (title: string, reason: string): AuthNeed => ({ title, reason })

/** git:只拦真正不可逆的那几个子命令。status/diff/log/add/commit 全部放行。 */
function git(argv: string[]): AuthNeed | null {
  const s = sub(argv)
  if (s === 'push') return need('git push', '推出去就收不回来了')
  if (s === 'reset' && has(argv, '--hard')) return need('git reset --hard', '会丢掉未提交的改动')
  if (s === 'clean' && argv.some(a => /^-[a-z]*[fd]/.test(a))) return need('git clean', '会删掉未跟踪的文件')
  if (s === 'remote') return need('git remote', '改的是推去哪儿')
  if (s === 'filter-branch' || s === 'filter-repo') return need(`git ${s}`, '会重写历史')
  if (s === 'rebase' && has(argv, '--onto', '-i', '--interactive')) return need('git rebase', '会重写历史')
  return null
}

/** rm:单个文件放行(改错了 git 能救),`-r` / `-f` 拦 —— 那才是收不回来的形态。 */
function rm(argv: string[]): AuthNeed | null {
  return argv.some(a => /^-[a-zA-Z]*[rRf]/.test(a)) ? need('rm', '递归 / 强制删除,删掉就没了') : null
}

/** 包管理器:装依赖放行,**发布**拦。 */
function pkg(cmd: string, argv: string[]): AuthNeed | null {
  return sub(argv) === 'publish' ? need(`${cmd} publish`, '会把包发到公开仓库') : null
}

/** 云 / 集群 CLI:读放行,改和删拦。 */
const MUTATING = new Set(['delete', 'apply', 'create', 'replace', 'patch', 'scale', 'drain', 'cordon',
  'rollout', 'exec', 'cp', 'push', 'rm', 'destroy', 'upgrade', 'install', 'uninstall', 'run', 'stop', 'kill'])

function cloud(cmd: string, argv: string[]): AuthNeed | null {
  // aws / gcloud 的动词在后面(`aws s3 rm`、`gcloud compute instances delete`),所以扫全部位置参数。
  const words = argv.filter(a => !a.startsWith('-'))
  const hit = words.find(w => MUTATING.has(w))
  return hit ? need(`${cmd} ${words.slice(0, 3).join(' ')}`.trim(), `会改动 ${cmd} 那边的真实资源`) : null
}

export function needsAuth(command: string, argv: string[]): AuthNeed | null {
  switch (command) {
    case 'git': return git(argv)
    case 'rm': return rm(argv)
    // 提权本身就是要问的那件事,不看参数。
    case 'sudo': return need('sudo', '要用管理员权限执行')
    case 'ssh': return need('ssh', '会在另一台机器上执行命令')
    case 'scp': case 'rsync': return need(command, '会把文件传到别处')
    case 'npm': case 'pnpm': case 'yarn': return pkg(command, argv)
    case 'kubectl': case 'docker': case 'helm': case 'terraform': case 'aws': case 'gcloud':
      return cloud(command, argv)
    // ★不在名单里的命令根本不该走到这儿(shim 目录里没有它)。真走到了也放行 ——
    //  宁可漏一个,也不能把 `ls` 拦死。
    default: return null
  }
}
