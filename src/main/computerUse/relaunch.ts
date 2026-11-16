/**
 * Options for `app.relaunch()`. On a packaged macOS build the new instance must come from LaunchServices: Electron's
 * own relaunch forks it from a relauncher child, so its responsible process is the old instance. Once that has exited
 * the responsibility SPI answers every pid in the tree for itself (measured, macOS 26), forge-cu then reads as its own
 * responsible process and refuses (`self_responsible`), and TCC would judge it by its own identity anyway.
 * `open -n <bundle>` lets launchd start the app as its own responsible process. undefined = Electron's default.
 */
export function relaunchOptions(platform: NodeJS.Platform, isPackaged: boolean, execPath: string): { execPath: string; args: string[] } | undefined {
  if (platform !== 'darwin' || !isPackaged) return undefined
  const i = execPath.lastIndexOf('.app/Contents/MacOS/')
  if (i < 0) return undefined
  return { execPath: '/usr/bin/open', args: ['-n', execPath.slice(0, i + '.app'.length)] }
}
