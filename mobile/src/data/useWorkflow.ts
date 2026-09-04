import { useCallback, useEffect, useMemo, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import type { WorkflowSessionState } from '../../../src/shared/workflowSession'
import type { CatalogStage } from './flowDraft'
import { useConn } from '../net/conn'
import { useStore } from './store'

/**
 * 对话式工作流(2026-07-30 重构后的形态)。
 *
 * 它**不是**「按下去自动跑完五个阶段」的编排,而是挂在某个会话上的一层很轻的状态机:
 * 你在会话里照常说话,顶部多一条状态条告诉你「现在是第几步」,点「下一步」才推进。
 * 只有推进到扇出阶段(每个项目各起一个代理)时,才交给 run2 真正开跑。
 *
 * 手机端能做的三件事:**选一个已有工作流启动**、**推进**、**退出**。
 * ★2026-09-04 补了第四件:**改工作流本身**(`app/flow-edit.tsx` —— 改名、加删阶段、调顺序、
 *  换默认代理、开关确认门),存回主机的 workspace.json,电脑端同步生效。
 *  提示词 / CR 视角 / hooks 仍然不做:一屏塞不下,也不是能在手机上顺手改对的东西。
 */

/**
 * 一个阶段,**服务端已经解析好的**(`run2:launch-info` → `buildLaunchInfo`)。
 *
 * ★★手机端**不自己解析** `ws.workflows[].stages`:那需要再实现一遍「全局模板回退 + libId 引用
 *  自定义阶段库」这两条路,而两边一旦走偏,手机上预览到的流程和真跑起来的流程就不是一回事 ——
 *  这种错在屏幕上完全看不出来。电脑端启动门(`LaunchGateCard`)吃的就是这个通道,两边同一份数据。
 * ★`code` = 这个阶段天生按项目扇出/写代码;`producesDoc` = 必须产出唯一一份方案文件。
 *  能不能改代理、能不能切「按项目」由这两个字段决定 —— 判定在 `@shared/launchStages`,两端共用。
 */
export type StageInfo = {
  key: string
  name: string
  provider: string
  model: string
  gate: boolean
  code: boolean
  producesDoc?: boolean
  desc?: string
  projectAgents?: { name: string; provider: string; model: string }[]
}
export type WorkflowInfo = { id: string; name: string; stages: StageInfo[] }
export type ProjectInfo = { name: string; provider: string; model: string }

/** 当前会话所在的工作流状态。没在工作流里就是 null。 */
export function useWorkflow() {
  const { invoke, online } = useConn()
  const { selected, groups } = useStore()

  const wf: WorkflowSessionState | null = useMemo(() => {
    if (!selected) return null
    const g = groups.find((x) => x.ws.path === selected.wsPath)
    return g?.sessions.find((s) => s.id === selected.sessionId)?.workflowSession ?? null
  }, [groups, selected])

  const stage = wf?.stages[wf.currentIndex]
  const nextStage = wf?.stages[(wf?.currentIndex ?? 0) + 1]

  /**
   * 推进按钮的文案。照抄桌面端的算法 —— **别在对话阶段把它叫「开始执行」**,
   * 那会让人以为已经在跑了。真正开跑发生在点下去之后。
   */
  const advanceLabel = !wf
    ? ''
    : wf.phase === 'done'
      ? ''
      : !nextStage
        ? '完成工作流'
        : stage && nextStage.provider !== stage.provider
          ? `下一步 · ${nextStage.name}(换 ${nextStage.provider})`
          : `下一步 · ${nextStage.name}`

  /** 下一步会不会真的开始烧钱:下一阶段是 per-project = 每个项目各起一个代理。 */
  const nextIsExecution = nextStage?.scope === 'per-project'

  const advance = useCallback(async () => {
    if (!selected) return
    await invoke(CH.workflowAdvance, [{ workspacePath: selected.wsPath, sessionId: selected.sessionId }])
  }, [invoke, selected])

  const exit = useCallback(async () => {
    if (!selected) return
    await invoke(CH.workflowExit, [{ workspacePath: selected.wsPath, sessionId: selected.sessionId }])
  }, [invoke, selected])

  /**
   * 补充说明 —— 手机上**唯一能影响正在跑的工作流**的手段(设计文档十·三条重点说明之三)。
   * 只在执行尾段有意义:它进的是 run2 的待发反馈队列,下一个阶段的提示词会把它带上。
   * 对话阶段不需要这个通道 —— 那时你直接在输入框里说话就行。
   */
  const addFeedback = useCallback(
    async (text: string) => {
      if (!selected || !text.trim()) return
      await invoke(CH.run2AddFeedback, [{ workspacePath: selected.wsPath, text: text.trim() }])
    },
    [invoke, selected],
  )

  return { wf, stage, nextStage, advanceLabel, nextIsExecution, advance, exit, addFeedback, online }
}

/** 启动屏要的两份清单:这个工作区有哪些工作流、有哪些项目。都是现问,不预置。 */
export function useLaunchOptions(wsPath: string | null) {
  const { invoke, online } = useConn()
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([])
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  /**
   * ★初值就是 true(只要有工作区、又连着)。`false` 的话第一帧是「加载完了、什么都没有」——
   *  启动屏闪一下「这个工作区还没有工作流」,编辑屏闪一下「这条工作流不在了」。
   *  下面那个 effect 在**首帧画完之后**才跑,补不回这一帧。
   */
  const [loading, setLoading] = useState(!!wsPath && !!online)
  const [error, setError] = useState<string | null>(null)
  /**
   * 重新拉一次。★2026-09-04 加的:编辑屏是**推上去的一层**,从它返回时启动屏并没有重新挂载 ——
   *  不主动拉,刚在编辑屏里改完的流程在启动屏上还是老样子(而且看不出来是旧的)。
   */
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!wsPath || !online) return
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        /**
         * ★★2026-09-04 从 `workspace:get` 换成 `run2:launch-info`。
         *  原来拿的是工作区原始结构,而且**只留了 `{id, name}`,阶段整个丢掉** ——
         *  于是手机上连「这条流程有哪几步」都看不见。`run2:launch-info` 回的是服务端解析完的
         *  `LaunchInfo`:阶段名、默认代理、按不按项目、逐项目代理全在里面,而且**和电脑端启动门
         *  是同一个通道** —— 两边不可能对不上。
         */
        const info = (await invoke(CH.run2LaunchInfo, [{ workspacePath: wsPath }])) as {
          workflows?: (WorkflowInfo & { stages?: StageInfo[] })[]
          projects?: { name?: string; provider?: string; model?: string }[]
        }
        if (!alive) return
        setWorkflows(
          (info?.workflows ?? []).map((w) => ({ id: w.id, name: w.name, stages: w.stages ?? [] })),
        )
        setProjects(
          (info?.projects ?? [])
            .map((p) => ({ name: p.name ?? '', provider: p.provider ?? '', model: p.model ?? '' }))
            .filter((p) => p.name),
        )
        setLoading(false)
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [wsPath, online, invoke, nonce])

  return { workflows, projects, loading, error, reload }
}

/**
 * 「加一个阶段」那张单子:内置阶段 + 全局自定义阶段库。
 *
 * ★★同样是**主机算好了给**(`workflow:stage-catalog`),手机不自己拼:每个阶段的默认代理来自
 *  用户在电脑端配的全局模板,天生按项目 / 必须产出文档这两个标记也来自主机的默认表。
 *  在手机上写一份等价的常量表,只要哪天电脑端改了默认,两边就开始各说各的 —— 而这种偏差
 *  在屏幕上完全看不出来(加进去的阶段看着一模一样,跑起来用的是另一个模型)。
 */
export function useStageCatalog() {
  const { invoke, online } = useConn()
  const [builtin, setBuiltin] = useState<CatalogStage[]>([])
  const [custom, setCustom] = useState<CatalogStage[]>([])

  useEffect(() => {
    if (!online) return
    let alive = true
    void (async () => {
      try {
        const cat = (await invoke(CH.workflowStageCatalog, [])) as { builtin?: CatalogStage[]; custom?: CatalogStage[] }
        if (!alive) return
        setBuiltin(cat?.builtin ?? [])
        setCustom(cat?.custom ?? [])
      } catch {
        // 拉不到就是空单子 —— 编辑屏会说「加不了阶段」,不该把整屏顶掉。
      }
    })()
    return () => {
      alive = false
    }
  }, [online, invoke])

  return { builtin, custom }
}
