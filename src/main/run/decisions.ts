import { advance, redo, jumpBack, type MachineState } from './machine'
import type { AskAnswers } from '@shared/types'
import type { ConfirmDecision } from '../agents/types'

export type GateDecision =
  | { type: 'advance' }
  | { type: 'redo'; feedback?: string }
  | { type: 'jumpBack'; targetKey: string; feedback?: string }
  // 工作流交互: the user is ASKING a question about this stage's output (not supplementing/approving) —
  // e.g. "这个待澄清项是什么意思？". The controller answers it with a one-shot over the ROOT provider
  // (gateAnswer.ts) and re-raises the SAME gate, WITHOUT re-running the stage. Never routed through
  // applyGateDecision (no machine transform — the stage stays put); handled directly in the gate loop.
  | { type: 'ask'; question: string }
  // P4-3/#6: resolves the run-completion "收尾确认" gate (a GateEvent with `finalize: true` — see
  // events.ts) — now a three-way choice (plus `handoff` below, for a failed finalize) instead of the
  // original two: `merge` → mergeTempBranch every participating project onto its target branch;
  // `discard` → discardTempBranch (真删，需要 UI 二次确认); `park` → parkTempBranch (keep the branch,
  // restore the user's pre-run snapshot — the SAFE default way to say "not this one"). Never routed
  // through applyGateDecision's per-stage machine transform (the machine is already all-`done` by the
  // time this gate appears) — the controller dispatches these directly in runFinalizeGate(). Reusing
  // GateDecision (rather than a separate decision type) means the existing resolveGate/gateR/IPC/
  // renderer plumbing needs no new resolve path.
  | { type: 'merge' }
  | { type: 'discard' }
  // 「先不合并」：把这次运行的改动留在 forge/run-<id> 上（不删分支），并把用户运行前那些未提交的
  // 改动原样还原回工作树。这是收尾门上「不要这次结果」的**默认**路径 —— 点错也丢不了东西。
  // 真正的删除走 'discard'，UI 上需要二次确认。
  | { type: 'park' }
  // 合并失败后用户点「知道了，我自己处理」：不再重试合并，把这个 run 标记为已收尾落盘，
  // 这样 Run2Manager.isUnfinalizedFailure 不再认它，切会话回来不会一次次弹同一个失败。
  // status 保持 'failed'（收尾确实没自动完成），finalized 表达的是「用户已接管」。
  | { type: 'handoff' }

export type LaneDecision =
  | { type: 'authorize' }
  | { type: 'deny' }
  | { type: 'answer'; value: string }
  // 回答一道「模型在问人」的授权(AuthEvent 带 questions,即 claude 的 AskUserQuestion)。
  // 与 'authorize' 分开是因为放行和回答根本是两件事:只 authorize 会让 CLI 拿空 answers 跑完工具,阶段代理
  // 收到「用户没有回答」。也与 'answer' 分开 —— 那个回的是 onInput 的一行自由文本,没有按题归属的选项。
  | { type: 'answerQuestions'; answers?: AskAnswers; response?: string }
  | { type: 'escalate' }
  | { type: 'skipLane' }
  | { type: 'retry' }
  | { type: 'abort' }
  // The following three resolve a "doubt" (方案存疑, §7.2/§7.7) event — doubt events carry a
  // laneId so they're resolved through the same resolveLane/laneR machinery as auth/question/
  // failure, rather than through resolveGate. `dismiss` (驳回继续) has no machine transform: the
  // controller just drops the event and lets the stage proceed as it otherwise would. `redo`
  // (补充说明后继续) and `jumpBack` (回退改方案) reuse GateDecision's shapes verbatim so the
  // controller can apply them via the same applyGateDecision()/machine transforms as a real
  // gate decision. `jumpBack.targetKey` is optional here (unlike GateDecision, where it's
  // required): the doubt-resolution UI is a single "回退到方案" button with no stage picker, so
  // when omitted the controller defaults it to the plan's design stage (first gated stage,
  // falling back to the first stage).
  | { type: 'dismiss' }
  | { type: 'redo'; feedback?: string }
  | { type: 'jumpBack'; targetKey?: string; feedback?: string }

// 一条 lane 的授权决定 → provider 的 onConfirm 返回值。放行/拒绝照旧走二值;而「回答了问题」必须带着选择
// 走对象形态,否则 CLI 拿空 answers 跑完 AskUserQuestion,阶段代理只会收到「用户没有回答」。
export function laneDecisionToConfirm(d: LaneDecision): ConfirmDecision {
  if (d.type === 'answerQuestions') return { decision: 'allow', answers: d.answers, response: d.response }
  return d.type === 'authorize' ? 'allow' : 'deny'
}

export function applyGateDecision(s: MachineState, d: GateDecision): MachineState {
  switch (d.type) {
    case 'advance': return advance(s)
    case 'redo': return redo(s)
    case 'jumpBack': return jumpBack(s, d.targetKey)
    // 'merge'/'discard'/'park'/'handoff' resolve the finalize gate (see GateDecision doc above) —
    // the controller never calls applyGateDecision for these (there's no stage left to transform),
    // so these are unreachable no-ops kept only so this switch stays exhaustive.
    case 'merge': return s
    case 'discard': return s
    case 'park': return s
    case 'handoff': return s
    // 'ask' is answered + re-raised in the gate loop, never applied to the machine — no-op here so the
    // switch stays exhaustive.
    case 'ask': return s
  }
}
