import { readWorkspaceRegistry } from '../config/store'

export function isArchivedWorkspace(path: string): boolean {
  return readWorkspaceRegistry().find(w => w.path === path)?.archived ?? false
}
