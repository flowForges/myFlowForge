import type { OpenMode } from '../../shared/openers'

// One curated entry in the opener whitelist. `bundleIds` drive detection (Spotlight) + launching
// (`open -b`/`-a`); the first installed bundle id wins. macOS-first; Windows/Linux support is a
// follow-up (this list is macOS bundle ids).
export interface OpenerSpec {
  id: string
  name: string
  bundleIds: string[]
  openMode: OpenMode
}

// Curated whitelist of dev tools that can open a folder/file. Order = display order in the dropdown.
// Editors that accept `<folder> <file>` in one shot are `together`; Xcode opens folder+file in two
// steps; Finder/terminals can't target a file so they open the file's parent folder.
export const OPENER_CATALOG: OpenerSpec[] = [
  { id: 'vscode', name: 'VS Code', bundleIds: ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders'], openMode: 'together' },
  { id: 'cursor', name: 'Cursor', bundleIds: ['com.todesktop.230313mzl4w4u92'], openMode: 'together' },
  { id: 'antigravity', name: 'Antigravity', bundleIds: ['com.google.antigravity', 'dev.antigravity.Antigravity'], openMode: 'together' },
  { id: 'windsurf', name: 'Windsurf', bundleIds: ['com.exafunction.windsurf', 'com.codeium.windsurf'], openMode: 'together' },
  { id: 'zed', name: 'Zed', bundleIds: ['dev.zed.Zed'], openMode: 'together' },
  { id: 'sublime', name: 'Sublime Text', bundleIds: ['com.sublimetext.4', 'com.sublimetext.3'], openMode: 'together' },
  { id: 'goland', name: 'GoLand', bundleIds: ['com.jetbrains.goland'], openMode: 'together' },
  { id: 'idea', name: 'IntelliJ IDEA', bundleIds: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'], openMode: 'together' },
  { id: 'pycharm', name: 'PyCharm', bundleIds: ['com.jetbrains.pycharm', 'com.jetbrains.pycharm.ce'], openMode: 'together' },
  { id: 'webstorm', name: 'WebStorm', bundleIds: ['com.jetbrains.WebStorm'], openMode: 'together' },
  { id: 'phpstorm', name: 'PhpStorm', bundleIds: ['com.jetbrains.PhpStorm'], openMode: 'together' },
  { id: 'rustrover', name: 'RustRover', bundleIds: ['com.jetbrains.rustrover'], openMode: 'together' },
  { id: 'clion', name: 'CLion', bundleIds: ['com.jetbrains.CLion'], openMode: 'together' },
  { id: 'rider', name: 'Rider', bundleIds: ['com.jetbrains.rider'], openMode: 'together' },
  { id: 'datagrip', name: 'DataGrip', bundleIds: ['com.jetbrains.datagrip'], openMode: 'together' },
  { id: 'xcode', name: 'Xcode', bundleIds: ['com.apple.dt.Xcode'], openMode: 'folder-then-file' },
  { id: 'finder', name: 'Finder', bundleIds: ['com.apple.finder'], openMode: 'folder-only' },
  { id: 'terminal', name: 'Terminal', bundleIds: ['com.apple.Terminal'], openMode: 'folder-only' },
  { id: 'iterm', name: 'iTerm', bundleIds: ['com.googlecode.iterm2'], openMode: 'folder-only' },
]
