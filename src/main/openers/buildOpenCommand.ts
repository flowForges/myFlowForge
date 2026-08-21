import { posix, win32 } from 'node:path'
import type { OpenMode, OpenTarget, WinArgStyle } from '../../shared/openers'

// One process launch. Pure data so this module stays unit-testable; the actual spawning lives in the
// IPC handler. macOS goes through the `open` helper (it knows how to activate an .app bundle);
// Windows has no such helper — an app IS its .exe, so we launch it directly.
export interface LaunchCommand {
  exe: string
  args: string[]
}

// Build the launch(es) for opening a target with an opener. Each command is run in order.
export function buildOpenCommand(
  platform: NodeJS.Platform,
  openMode: OpenMode,
  appPath: string,
  target: OpenTarget,
  argStyle: WinArgStyle = 'paths',
): LaunchCommand[] {
  const paths = targetPaths(platform, openMode, target)
  // macOS launches an .app bundle through the `open` helper; on Windows the app IS its .exe.
  const launch = (ps: string[]): LaunchCommand =>
    platform === 'win32' ? { exe: appPath, args: ps } : { exe: 'open', args: ['-a', appPath, ...ps] }
  // 'cwd-flag' apps (Windows Terminal) treat a bare argument as a COMMAND TO RUN, not a directory to
  // start in — passing the folder positionally would try to execute it. They take `-d <dir>`.
  if (platform === 'win32' && argStyle === 'cwd-flag') return [{ exe: appPath, args: ['-d', paths[0]] }]
  // 'together' = ONE launch carrying every path; the other modes are one launch per path.
  if (openMode === 'together') return [launch(paths)]
  return paths.map(p => launch([p]))
}

// Which filesystem paths this open should actually target, per mode.
function targetPaths(platform: NodeJS.Platform, openMode: OpenMode, target: OpenTarget): string[] {
  const { folder, file } = target
  if (!file) return [folder]
  switch (openMode) {
    case 'together':
    case 'folder-then-file':
      return [folder, file]
    case 'folder-only':
      // Can't target a file — open the folder that contains it so the user lands next to it.
      return [(platform === 'win32' ? win32 : posix).dirname(file)]
  }
}
