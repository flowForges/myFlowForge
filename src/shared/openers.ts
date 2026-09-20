// Shared (main + renderer) types for the "用外部软件打开" (open-in external app) feature.

// How an opener handles opening a folder together with a specific file:
//  - together         : one command opens the folder AND reveals the file (VS Code / Cursor / JetBrains…)
//  - folder-then-file : two commands — open the folder, then open the file (Xcode-style fallback)
//  - folder-only      : the app can't target a file; when a file is given, open its parent folder
//                       (Finder / Terminal / iTerm)
export type OpenMode = 'together' | 'folder-then-file' | 'folder-only'

// Windows-only: how an opener's executable wants the target handed to it.
//  - paths    : positional path arguments (every editor)
//  - cwd-flag : a `-d <dir>` flag (Windows Terminal — a bare argument would be run as a COMMAND)
export type WinArgStyle = 'paths' | 'cwd-flag'

// A detected (installed) opener, returned to the renderer. `icon` is a dataURL of the app's real
// icon (best-effort; may be absent, renderer falls back to a generic glyph).
export interface DetectedOpener {
  id: string
  name: string
  openMode: OpenMode
  appPath: string
  icon?: string
  // Windows only — how this executable wants the target handed to it (see WinArgStyle).
  argStyle?: WinArgStyle
}

// What "打开位置" should open: always a folder, optionally a file within it (absolute paths).
export interface OpenTarget {
  folder: string
  file?: string
}
