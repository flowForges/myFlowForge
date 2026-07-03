import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SourceRoots {
  claude: string   // ~/.claude/projects
  codex: string    // ~/.codex/sessions
  cursor: string   // ~/.cursor/projects
  qoder: string    // ~/.qoder/logs/sessions
}

export function defaultRoots(home = homedir()): SourceRoots {
  return {
    claude: join(home, '.claude', 'projects'),
    codex: join(home, '.codex', 'sessions'),
    cursor: join(home, '.cursor', 'projects'),
    qoder: join(home, '.qoder', 'logs', 'sessions'),
  }
}

// `/`→`-` 编码不可逆(真实路径含 `-` 时);仅作回退解码。
// claude/qoder 目录名带前导 `-`,cursor 不带;统一去掉前导标记后保证绝对路径。
export function decodeDirCwd(dirName: string): string {
  return '/' + dirName.replace(/^-/, '').replace(/-/g, '/')
}
