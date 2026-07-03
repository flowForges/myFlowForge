import { basename } from 'node:path'
import { registerWorkspace } from '../config/store'

// Register an external folder as a *lightweight* workspace: central registry entry only.
// Never writes <cwd>/.forge/workspace.json — the real repo stays untouched (read-only semantics).
export function importWorkspace(cwd: string): void {
  registerWorkspace(basename(cwd) || cwd, cwd)
}
