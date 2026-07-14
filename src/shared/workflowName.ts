// Workflow display names must be unique so two workflows can't render as indistinguishable cards/tabs.
// True when `name` (trimmed, case-insensitive) already matches one of `existing`. Empty/whitespace
// name is never "taken" (the caller handles empty separately). Shared by both create sites + the IPC
// handler so the rule is enforced identically everywhere.
export function workflowNameTaken(name: string, existing: string[]): boolean {
  const n = name.trim().toLowerCase()
  if (!n) return false
  return existing.some(e => e.trim().toLowerCase() === n)
}
