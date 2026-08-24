import { useCallback, useEffect, useMemo, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import type { WorkflowSessionState } from '../../../src/shared/workflowSession'
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
 * 编辑工作流一律不做(阶段 / 提示词 / hooks 在手机上是一张巨型表单,编错了后果还很严重)。
 */

export type WorkflowInfo = { id: string; name: string }
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!wsPath || !online) return
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const ws = (await invoke(CH.workspaceGet, [wsPath])) as {
          workflows?: { id: string; name: string }[]
          projects?: { name?: string; repoId?: string; provider?: string; model?: string }[]
        }
        if (!alive) return
        setWorkflows((ws?.workflows ?? []).map((w) => ({ id: w.id, name: w.name })))
        setProjects(
          (ws?.projects ?? [])
            .map((p) => ({ name: p.name || p.repoId || '', provider: p.provider ?? '', model: p.model ?? '' }))
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
  }, [wsPath, online, invoke])

  return { workflows, projects, loading, error }
}
