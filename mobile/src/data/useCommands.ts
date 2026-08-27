import { useEffect, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import type { SlashCommand } from '../ui/slashPick'
import { useConn } from '../net/conn'

/**
 * 这台**远程主机**上,当前这个代理 + 这个工作区真实有哪些斜杠命令。
 *
 * ★数据源是电脑端天天在用的那条 channel:`commands:list`(`src/main/ipc/handlers.ts:392` →
 *  `providerCommands(providerId, wsPath)`)。它扫的是**用户自己磁盘上的文件** ——
 *  `~/.claude/commands/*.md`、工作区里的 `.claude/commands/*.md`、`~/.codex/prompts/*.md`……
 *  外加那个 provider 装了的技能。所以**必须现问,不能预置**:哪台机器有哪几条,只有那台机器知道。
 *
 * ★★**按代理 + 按工作区各问一次**,和电脑端 `WorkspaceView.tsx:439` 的依赖数组一模一样
 *  (`[selection?.agentId, wsPath]`)。这两样任一变了都得重问:claude 和 codex 的命令目录
 *  根本不是同一个,而工作区那一半是**项目自带**的命令 —— 拿 A 项目的清单去 B 项目里补全,
 *  等于把一条不存在的命令递到人手上。
 *
 * ★**主机没有这个方法就明说没有**(`supported`),不要退回一个空数组假装「你没有命令」:
 *  老版本的 daemon / app 里根本没有这条 channel,那种情况下 `invoke` 会带着
 *  「这台机器没有这个方法」被拒绝。面板据此**整个不摆** —— 同 `pickSupport.ts` / `copy.ts`
 *  的规矩:说明了原因的「没有」,好过一个点了没反应的控件。
 */
export function useCommands(agentId: string | null, wsPath: string | null) {
  const { invoke, online, methods, epoch } = useConn()
  const [commands, setCommands] = useState<SlashCommand[]>([])
  // `methods` 只在连接 ready 时才非空(见 `conn.tsx`),所以「还没连上」在这里自动就是 false。
  const supported = methods.has(CH.commandsList)

  useEffect(() => {
    if (!online || !supported || !agentId) {
      setCommands([])
      return
    }
    let alive = true
    void (async () => {
      try {
        // ★位置参数,不是一个对象:这条 channel 的签名是 `(providerId, wsPath?)`,
        //  网关那边是 `fn(ctx, ...args)` 原样展开的(`gateway.ts:126`)。
        //  `wsPath` 传 `undefined` 会在 JSON 里变成 `null`,handler 那边 `wsPath ? … : null`
        //  照样当「没有工作区」处理,所以不用特意抹掉。
        const list = (await invoke(CH.commandsList, [agentId, wsPath ?? undefined])) as SlashCommand[] | null
        if (!alive) return
        // 服务端理论上只会回数组,但这是跨机器的一条线 —— 版本对不上时回什么都可能,
        // 拿一个非数组去 `.filter` 就是整屏白。
        setCommands(Array.isArray(list) ? list.filter((c) => typeof c?.cmd === 'string' && c.cmd.startsWith('/')) : [])
      } catch {
        // 问不到就是没有。这一条失败绝不该拦住输入框 —— 人来这儿是发消息的,不是挑命令的。
        if (alive) setCommands([])
      }
    })()
    return () => {
      alive = false
    }
  }, [invoke, online, supported, agentId, wsPath, epoch])

  return { commands, supported }
}
