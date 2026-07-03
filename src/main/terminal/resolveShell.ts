// Resolve the user's login shell. $SHELL is what their iTerm/Warp/JetBrains terminal also use; we fall
// back through the macOS defaults. Always a login shell (-l) so ~/.zshrc etc. load (PATH, prompt theme).
export function resolveShell(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): { shell: string; args: string[] } {
  const candidates = [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean) as string[]
  const shell = candidates.find(exists) ?? '/bin/sh'
  return { shell, args: ['-l'] }
}
