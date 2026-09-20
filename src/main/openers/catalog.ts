import type { OpenMode, WinArgStyle } from '../../shared/openers'

// One curated entry in the opener whitelist, with a per-platform way to LOCATE the app. A spec is
// only considered on a platform it declares — that's what keeps Finder off Windows and File Explorer
// off macOS, without a parallel catalog to keep in sync.
export interface OpenerSpec {
  id: string
  name: string
  openMode: OpenMode
  mac?: MacLocator
  win?: WinLocator
}

// macOS: Spotlight resolves a bundle id to the installed .app; the first installed id wins.
export interface MacLocator { bundleIds: string[] }

// Windows: an app is an .exe, and there is no Spotlight. Two ways to find it, in order:
//   paths — templates probed against the filesystem (see winPaths.ts for %VAR% and * semantics)
//   exe   — the executable name to look up under the registry's `App Paths`, which catches installs
//           in locations no template can guess. Omit for apps that don't register one.
export interface WinLocator { paths: string[]; exe?: string; argStyle?: WinArgStyle }

// The JetBrains IDEs all live under a version-stamped directory, and the layout differs between the
// standalone installer, JetBrains Toolbox 1.x (apps/<code>/<channel>/<build>/bin) and Toolbox 2.x
// (Programs/<name>/bin). The executable name is unique per product, so a wildcard for the parts we
// can't know covers every layout without hardcoding Toolbox's product codes.
const jetbrains = (exe: string): WinLocator => ({
  paths: [
    `%ProgramFiles%\\JetBrains\\*\\bin\\${exe}`,
    `%ProgramFiles(x86)%\\JetBrains\\*\\bin\\${exe}`,
    `%LOCALAPPDATA%\\Programs\\*\\bin\\${exe}`,
    `%LOCALAPPDATA%\\JetBrains\\Toolbox\\apps\\*\\bin\\${exe}`,
    `%LOCALAPPDATA%\\JetBrains\\Toolbox\\apps\\*\\*\\*\\bin\\${exe}`,
  ],
  exe,
})

// VS Code and its forks all ship a "user setup" (per-user, under LOCALAPPDATA — the default download)
// and a "system setup" (under Program Files).
const vscodeLike = (dir: string, exe: string, extra: string[] = []): WinLocator => ({
  paths: [
    `%LOCALAPPDATA%\\Programs\\${dir}\\${exe}`,
    `%ProgramFiles%\\${dir}\\${exe}`,
    `%ProgramFiles(x86)%\\${dir}\\${exe}`,
    ...extra,
  ],
  exe,
})

// Curated whitelist of dev tools that can open a folder/file. Order = display order in the dropdown.
// Editors that accept `<folder> <file>` in one shot are `together`; Xcode opens folder+file in two
// steps; file managers/terminals can't target a file so they open the file's parent folder.
export const OPENER_CATALOG: OpenerSpec[] = [
  {
    id: 'vscode', name: 'VS Code', openMode: 'together',
    mac: { bundleIds: ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders'] },
    win: vscodeLike('Microsoft VS Code', 'Code.exe', ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe']),
  },
  {
    id: 'cursor', name: 'Cursor', openMode: 'together',
    mac: { bundleIds: ['com.todesktop.230313mzl4w4u92'] },
    win: vscodeLike('cursor', 'Cursor.exe', ['%LOCALAPPDATA%\\Programs\\Cursor\\Cursor.exe']),
  },
  {
    id: 'antigravity', name: 'Antigravity', openMode: 'together',
    mac: { bundleIds: ['com.google.antigravity', 'dev.antigravity.Antigravity'] },
    win: vscodeLike('Antigravity', 'Antigravity.exe'),
  },
  {
    id: 'windsurf', name: 'Windsurf', openMode: 'together',
    mac: { bundleIds: ['com.exafunction.windsurf', 'com.codeium.windsurf'] },
    win: vscodeLike('Windsurf', 'Windsurf.exe'),
  },
  {
    id: 'zed', name: 'Zed', openMode: 'together',
    mac: { bundleIds: ['dev.zed.Zed'] },
    win: { paths: ['%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe', '%LOCALAPPDATA%\\Zed\\Zed.exe', '%ProgramFiles%\\Zed\\Zed.exe'], exe: 'Zed.exe' },
  },
  {
    id: 'sublime', name: 'Sublime Text', openMode: 'together',
    mac: { bundleIds: ['com.sublimetext.4', 'com.sublimetext.3'] },
    win: { paths: ['%ProgramFiles%\\Sublime Text\\sublime_text.exe', '%ProgramFiles%\\Sublime Text 3\\sublime_text.exe', '%ProgramFiles(x86)%\\Sublime Text 3\\sublime_text.exe'], exe: 'sublime_text.exe' },
  },
  { id: 'goland', name: 'GoLand', openMode: 'together', mac: { bundleIds: ['com.jetbrains.goland'] }, win: jetbrains('goland64.exe') },
  { id: 'idea', name: 'IntelliJ IDEA', openMode: 'together', mac: { bundleIds: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'] }, win: jetbrains('idea64.exe') },
  { id: 'pycharm', name: 'PyCharm', openMode: 'together', mac: { bundleIds: ['com.jetbrains.pycharm', 'com.jetbrains.pycharm.ce'] }, win: jetbrains('pycharm64.exe') },
  { id: 'webstorm', name: 'WebStorm', openMode: 'together', mac: { bundleIds: ['com.jetbrains.WebStorm'] }, win: jetbrains('webstorm64.exe') },
  { id: 'phpstorm', name: 'PhpStorm', openMode: 'together', mac: { bundleIds: ['com.jetbrains.PhpStorm'] }, win: jetbrains('phpstorm64.exe') },
  { id: 'rustrover', name: 'RustRover', openMode: 'together', mac: { bundleIds: ['com.jetbrains.rustrover'] }, win: jetbrains('rustrover64.exe') },
  { id: 'clion', name: 'CLion', openMode: 'together', mac: { bundleIds: ['com.jetbrains.CLion'] }, win: jetbrains('clion64.exe') },
  { id: 'rider', name: 'Rider', openMode: 'together', mac: { bundleIds: ['com.jetbrains.rider'] }, win: jetbrains('rider64.exe') },
  { id: 'datagrip', name: 'DataGrip', openMode: 'together', mac: { bundleIds: ['com.jetbrains.datagrip'] }, win: jetbrains('datagrip64.exe') },
  { id: 'xcode', name: 'Xcode', openMode: 'folder-then-file', mac: { bundleIds: ['com.apple.dt.Xcode'] } },
  { id: 'finder', name: 'Finder', openMode: 'folder-only', mac: { bundleIds: ['com.apple.finder'] } },
  { id: 'terminal', name: 'Terminal', openMode: 'folder-only', mac: { bundleIds: ['com.apple.Terminal'] } },
  { id: 'iterm', name: 'iTerm', openMode: 'folder-only', mac: { bundleIds: ['com.googlecode.iterm2'] } },
  // Windows-only. explorer.exe is always present; wt.exe only after the Windows Terminal install (it
  // ships with Windows 11) and takes its start directory via -d, not positionally.
  { id: 'explorer', name: 'File Explorer', openMode: 'folder-only', win: { paths: ['%SystemRoot%\\explorer.exe'] } },
  { id: 'wt', name: 'Windows Terminal', openMode: 'folder-only', win: { paths: ['%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe'], argStyle: 'cwd-flag' } },
]
