import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SourceRoots {
  claude: string   // ~/.claude/projects
  codex: string    // ~/.codex/sessions
  cursor: string   // ~/.cursor/projects
  qoder: string    // ~/.qoder/logs/sessions
}

type Env = Record<string, string | undefined>

/** 三家 CLI 的配置根目录;遵循各自的环境变量(只读取,不覆盖)。QODER_HOME 是 QODER_CONFIG_DIR 的别名。 */
export function configHomes(home = homedir(), env: Env = process.env): { claude: string; codex: string; qoder: string } {
  return {
    claude: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    codex: env.CODEX_HOME || join(home, '.codex'),
    qoder: env.QODER_CONFIG_DIR || env.QODER_HOME || join(home, '.qoder'),
  }
}

export function defaultRoots(home = homedir(), env: Env = process.env): SourceRoots {
  const h = configHomes(home, env)
  return {
    claude: join(h.claude, 'projects'),
    codex: join(h.codex, 'sessions'),
    cursor: join(home, '.cursor', 'projects'),
    qoder: join(h.qoder, 'logs', 'sessions'),
  }
}

// `/`→`-` 编码不可逆(真实路径含 `-` 时);仅作回退解码。
// claude/qoder 目录名带前导 `-`,cursor 不带;统一去掉前导标记后保证绝对路径。
export function decodeDirCwd(dirName: string): string {
  return '/' + dirName.replace(/^-/, '').replace(/-/g, '/')
}
