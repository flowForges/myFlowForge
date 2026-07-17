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

export function applyGateDecision(s: MachineState, d: GateDecision): MachineState {
  switch (d.type) {
    case 'advance': return advance(s)
    case 'redo': return redo(s)
    case 'jumpBack': return jumpBack(s, d.targetKey)
  }
}
