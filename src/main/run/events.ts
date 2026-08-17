import type { ArtifactRef } from './runTypes'
import type { AskQuestion } from '@shared/types'

// questions 非空 = 这道授权其实是模型在【问人】(claude AskUserQuestion 借权限通道发出来的),卡片要画成
// 可点的选项、并用 LaneDecision 的 answerQuestions 把选择带回去。只回 authorize 等于没回答 —— CLI 会拿空
// answers 把工具跑完,阶段代理收到「The user did not answer the questions.」。见 claudeControl.ts。
export interface AuthEvent { id: string; kind: 'auth'; laneId: string; stageKey: string; title: string; where?: string; questions?: AskQuestion[] }
export interface QuestionEvent { id: string; kind: 'question'; laneId: string; stageKey: string; title: string; placeholder?: string }
export interface DoubtEvent { id: string; kind: 'doubt'; laneId: string; stageKey: string; note: string }
export interface FailureEvent { id: string; kind: 'failure'; laneId: string; stageKey: string; error: string; attempts: number }
// `finalize`: P4-3 marker distinguishing the run-completion "收尾确认" gate (合并/丢弃 the run's
// temp branch, see tempBranch.ts) from an ordinary per-stage review gate. Reuses the SAME 'gate'
// kind (and therefore the same resolveGate/gateR/inbox machinery) rather than introducing a new
// RunEvent kind — least churn, since resolveGate already only cares that `e.kind === 'gate'`.
// Renderer (RunEventCard) branches on this flag to show 合并并完成/丢弃本次 instead of the normal
// 通过/打回本阶段/回退到某阶段 actions.
// `stageName`: #6 — the stage's human name (e.g. 技术方案设计) so the gate card titles itself with the
// stage instead of the generic 阶段评审. Emitted by the controller from stage.name; the renderer
// (RunEventCard) and the frozen gate card (runCards.FrozenRunCard) both carry it through.
// `producesDoc`: review findings (Task 7 fix wave 1) — a producesDoc stage's gate `body` is the FULL
// plan markdown (see controller.ts ~line 1030), which is fine for the live gate's body but WAY too
// big to ever use as a title (captureRunCardTitle/WorkspaceView.tsx would otherwise dump the whole
// plan into the frozen card's single-line `.req-title`, mirroring the finalize gate's pre-existing
// problem/fix). Carried through so the renderer can special-case it the same way it already does for
// `finalize`.
// `targetBranch`/`tempBranch`: #6 — only ever set on the finalize gate (`finalize: true`). The real
// branch names for THIS run, so the card can say "合并到 branch1" / show the temp branch a merge
// conflict left behind, instead of the user having to guess where their work went. Multi-project runs
// can in principle have differing per-project targets — the card shows `targetBranch` (the first
// project's) as a representative name; a merge-failure card lists every project's own target from
// `FinalizeFailure` (controller.ts) instead.
export interface GateEvent { id: string; kind: 'gate'; stageKey: string; stageName: string; body: string; docs?: ArtifactRef[]; finalize?: boolean; producesDoc?: boolean; targetBranch?: string; tempBranch?: string }
// 工作流交互: the answer to a user's gate question (GateDecision `ask`). Purely informational — it carries
// no resolver (unlike gate/auth/question/doubt); the controller emits it, then re-raises the gate. The
// renderer (RunEventCard) shows it as a Q&A card so the user sees their question + the AI's reply inline,
// with the same gate still open below for them to then 通过/打回/再问.
export interface AnswerEvent { id: string; kind: 'answer'; stageKey: string; stageName: string; question: string; body: string }

export type RunEvent = AuthEvent | QuestionEvent | DoubtEvent | FailureEvent | GateEvent | AnswerEvent

export function addEvent(inbox: RunEvent[], e: RunEvent): RunEvent[] {
  return [...inbox, e]
}
export function removeEvent(inbox: RunEvent[], id: string): RunEvent[] {
  return inbox.filter((e) => e.id !== id)
}
export function findEvent(inbox: RunEvent[], id: string): RunEvent | undefined {
  return inbox.find((e) => e.id === id)
}
