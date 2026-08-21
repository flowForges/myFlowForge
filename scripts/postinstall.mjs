// npm postinstall. Cross-platform on purpose: this used to be a bare
//   chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true
// which is POSIX shell. npm runs scripts through cmd.exe on Windows, where `chmod`, `2>/dev/null`
// and `true` are all unknown — so `npm install` FAILED on Windows before the app ever built.
import { chmodSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// node-pty's macOS prebuilds ship `spawn-helper` without the executable bit (npm doesn't preserve it
// through the tarball for this file), and node-pty exec()s it to start a PTY. Without +x every
// terminal pane fails to open in a packaged build. Nothing to do on other platforms.
if (process.platform === 'darwin') {
  const prebuilds = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty', 'prebuilds')
  try {
    for (const dir of readdirSync(prebuilds)) {
      if (!dir.startsWith('darwin-')) continue
      try { chmodSync(join(prebuilds, dir, 'spawn-helper'), 0o755) } catch { /* not every prebuild has one */ }
    }
  } catch { /* node-pty not installed (fresh clone, --ignore-scripts) — nothing to fix */ }
}
