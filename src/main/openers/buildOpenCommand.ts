import { dirname } from 'node:path'
import type { OpenMode, OpenTarget } from '../../shared/openers'

// Build the macOS `open` argv list(s) for launching an opener against a target. Each inner array is
// one `open <args...>` invocation, run in order. Pure (no side effects) so it's unit-testable; the
// actual spawning lives in the IPC handler.
export function buildOpenCommand(openMode: OpenMode, appPath: string, target: OpenTarget): string[][] {
  const { folder, file } = target
  if (!file) return [['-a', appPath, folder]]
  switch (openMode) {
    case 'together':
      return [['-a', appPath, folder, file]]
    case 'folder-then-file':
      return [['-a', appPath, folder], ['-a', appPath, file]]
    case 'folder-only':
      // Can't target a file — open the folder that contains it so the user lands next to it.
      return [['-a', appPath, dirname(file)]]
  }
}
