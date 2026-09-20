import { describe, it, expect } from 'vitest'
import { SHIMMED_COMMANDS, needsAuth } from './authPolicy'

/**
 * 「这条命令要不要问人」。
 *
 * ★★这是**唯一对所有 provider 都成立**的拦截点。claude/codex 有自己的审批协议、
 *  gemini/qwen 有 hook,而 qoder/cursor/opencode/copilot **三样都没有** —— 它们只支持「全放行」。
 *  对它们来说,PATH shim 是把授权收回 Forge 里的唯一办法(用户 2026-09-07 原话:
 *  「qoder等都得支持上啊,这个很重要,要授权,你不弹,用户不知道」)。
 *
 * ★★判据是**可逆性**,不是危险性:文件改动发生在 git worktree 里,回滚得掉;
 *  而 `git push` / `rm -rf` / 打生产的 curl / 部署脚本回滚不掉。**拦不可逆的那一半。**
 * ★读操作一律放行。`git status` 一轮要跑十几次,每次弹一下这个功能就没法用了 ——
 *  拦得太宽和不拦一样糟,用户会直接切回完全访问档。
 */
describe('放行:读操作和日常命令', () => {
  it('★git 的只读子命令不拦 —— 一轮跑十几次,拦了就没法用', () => {
    for (const argv of [['status'], ['diff', '--stat'], ['log', '-5'], ['show', 'HEAD'], ['branch'], ['rev-parse', 'HEAD']])
      expect(needsAuth('git', argv), `git ${argv.join(' ')}`).toBeNull()
  })
  it('git add / commit 不拦 —— 都在工作区里,回滚得掉', () => {
    expect(needsAuth('git', ['add', '-A'])).toBeNull()
    expect(needsAuth('git', ['commit', '-m', 'x'])).toBeNull()
  })
})

describe('拦截:不可逆的', () => {
  it('★★git push —— 推出去就收不回来了', () => {
    expect(needsAuth('git', ['push'])?.title).toBe('git push')
    expect(needsAuth('git', ['push', '--force', 'origin', 'main'])).toBeTruthy()
  })
  it('★git reset --hard / clean -fd —— 未提交的改动直接没', () => {
    expect(needsAuth('git', ['reset', '--hard'])).toBeTruthy()
    expect(needsAuth('git', ['clean', '-fd'])).toBeTruthy()
    expect(needsAuth('git', ['reset', 'HEAD~1']), '软 reset 不动工作区').toBeNull()
  })
  it('★rm -rf 拦,普通 rm 单个文件不拦', () => {
    expect(needsAuth('rm', ['-rf', 'build'])).toBeTruthy()
    expect(needsAuth('rm', ['a.txt'])).toBeNull()
  })
  it('★sudo 一律拦 —— 提权本身就是那件事', () => {
    expect(needsAuth('sudo', ['ls'])).toBeTruthy()
  })
  it('★发布 / 部署类一律拦', () => {
    expect(needsAuth('npm', ['publish'])).toBeTruthy()
    expect(needsAuth('npm', ['install']), '装依赖不拦').toBeNull()
    expect(needsAuth('kubectl', ['delete', 'pod', 'x'])).toBeTruthy()
    expect(needsAuth('kubectl', ['get', 'pods']), '读不拦').toBeNull()
    expect(needsAuth('terraform', ['apply'])).toBeTruthy()
    expect(needsAuth('terraform', ['plan'])).toBeNull()
  })
  it('★往外发东西的:ssh / scp / rsync 拦', () => {
    expect(needsAuth('ssh', ['prod', 'ls'])).toBeTruthy()
    expect(needsAuth('scp', ['a', 'b:/c'])).toBeTruthy()
  })
})

describe('形状', () => {
  it('★被拦时给的理由是给**人**看的,不是给正则看的', () => {
    const r = needsAuth('git', ['push', 'origin', 'main'])
    expect(r!.title).toContain('git')
    expect(r!.reason.length).toBeGreaterThan(4)
  })
  it('★不在 shim 名单里的命令根本不该走到这儿 —— 但真走到了也要放行,不能把 ls 拦死', () => {
    expect(needsAuth('ls', ['-la'])).toBeNull()
    expect(needsAuth('cat', ['x'])).toBeNull()
  })
  it('★shim 名单和策略必须对得上:名单里每个命令至少有一种写法会被拦', () => {
    const samples: Record<string, string[]> = {
      git: ['push'], rm: ['-rf', 'x'], sudo: ['ls'], ssh: ['h'], scp: ['a', 'b'], rsync: ['-a', 'a', 'b'],
      npm: ['publish'], pnpm: ['publish'], yarn: ['publish'], kubectl: ['delete', 'x'],
      docker: ['push', 'x'], helm: ['upgrade', 'x'], terraform: ['apply'], aws: ['s3', 'rm', 'x'], gcloud: ['compute', 'instances', 'delete'],
    }
    for (const c of SHIMMED_COMMANDS) {
      expect(samples[c], `名单里有 ${c} 却没给样例 —— 加命令时必须同时说明它什么时候该拦`).toBeTruthy()
      expect(needsAuth(c, samples[c]), `${c} 在名单里却永远不拦,那 shim 它只是白挨一层开销`).toBeTruthy()
    }
  })
})
