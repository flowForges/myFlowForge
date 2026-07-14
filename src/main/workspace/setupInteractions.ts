// Bridges a setup hook's (__basic/__proj) permission-confirm / input request to the UI and back.
//
// Setup hooks run inside createWorkspace/editWorkspace (not the orchestrator), so they can't use the
// orchestrator's raise→pending→gate-card machinery. Instead runStepHook emits a `hook:interact`
// SetupEvent (which reaches SetupProgress via the setup broadcast) and blocks on awaitSetupInteraction;
// the renderer posts the user's answer through the workspace:setup-resolve IPC, which calls
// resolveSetupInteraction to unblock the hook. Previously these callbacks were stubbed to 'deny'/'' so
// the request was silently denied with no prompt.

export interface SetupInteractionAnswer { decision?: 'allow' | 'deny'; value?: string }

const pending = new Map<string, (a: SetupInteractionAnswer) => void>()
let seq = 0

export function nextSetupInteractionId(pluginId: string): string {
  return `sh-${pluginId}-${Date.now()}-${++seq}`
}

// Register a pending interaction and get the promise the hook awaits. Resolved by resolveSetupInteraction
// (user answered) or cancelSetupInteraction (aborted).
export function awaitSetupInteraction(id: string): Promise<SetupInteractionAnswer> {
  return new Promise(res => pending.set(id, res))
}

export function resolveSetupInteraction(id: string, answer: SetupInteractionAnswer): void {
  const r = pending.get(id)
  if (r) { pending.delete(id); r(answer) }
}

// Same as resolve, but a no-op if already resolved — used to unblock a hook on cancel/abort.
export function cancelSetupInteraction(id: string, fallback: SetupInteractionAnswer): void {
  resolveSetupInteraction(id, fallback)
}
