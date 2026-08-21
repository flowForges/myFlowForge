import { win32 } from 'node:path'

// Resolve the shell a terminal pane should spawn. Two platform families, one entry point.
//
// POSIX: $SHELL is what their iTerm/Warp/JetBrains terminal also use; we fall back through the macOS
// defaults. Always a login shell (-l) so ~/.zshrc etc. load (PATH, prompt theme).
//
// Windows: there is no $SHELL convention — and when it IS set it's Git Bash pointing at an MSYS
// `bash.exe`, which is not a native shell and would get the wrong argv. So win32 ignores $SHELL and
// probes the real interpreters in preference order (pwsh 7 → Windows PowerShell → %COMSPEC%). Paths
// come from the environment (ProgramFiles/SystemRoot), never hardcoded `C:\`, because both move on
// localized installs and non-C: system drives. `-l` is POSIX-only; PowerShell gets `-NoLogo` so the
// pane opens on a clean line (profiles still load — that's `-NoProfile`, which we do NOT pass).
export function resolveShell(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): { shell: string; args: string[] } {
  if (platform === 'win32') return resolveWindowsShell(env, exists)
  const candidates = [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean) as string[]
  const shell = candidates.find(exists) ?? '/bin/sh'
  return { shell, args: ['-l'] }
}

function resolveWindowsShell(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): { shell: string; args: string[] } {
  const programFiles = env['ProgramFiles']
  const systemRoot = env['SystemRoot'] ?? env['windir']
  const candidates = [
    programFiles ? win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe') : undefined,
    systemRoot ? win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : undefined,
    env['COMSPEC'],
  ].filter(Boolean) as string[]
  // Last resort: a bare name, resolved through PATH by the spawner. cmd.exe is the one interpreter
  // guaranteed present on every Windows install, so it's the safest floor.
  const shell = candidates.find(exists) ?? 'cmd.exe'
  return { shell, args: isPowerShell(shell) ? ['-NoLogo'] : [] }
}

// -NoLogo is a PowerShell-only flag; cmd.exe would treat it as a (nonexistent) command to run.
function isPowerShell(shell: string): boolean {
  const exe = win32.basename(shell).toLowerCase()
  return exe === 'pwsh.exe' || exe === 'powershell.exe'
}
