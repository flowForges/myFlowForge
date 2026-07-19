import { advance, redo, jumpBack, type MachineState } from './machine'

export type GateDecision =
  | { type: 'advance' }
  | { type: 'redo'; feedback?: string }
  | { type: 'jumpBack'; targetKey: string; feedback?: string }

export type LaneDecision =
  | { type: 'authorize' }
  | { type: 'deny' }
  | { type: 'answer'; value: string }
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

export function applyGateDecision(s: MachineState, d: GateDecision): MachineState {
  switch (d.type) {
    case 'advance': return advance(s)
    case 'redo': return redo(s)
    case 'jumpBack': return jumpBack(s, d.targetKey)
  }
}
