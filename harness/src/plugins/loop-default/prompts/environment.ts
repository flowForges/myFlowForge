// 本轮用户消息前的提醒块(spec §8.2):只在本轮注入,不写进事件
import type { ApprovalMode } from '../../../protocol/index'

export interface EnvironmentInfo {
  cwd: string
  platform: NodeJS.Platform
  date: Date
  isGit: boolean
  approvalMode: ApprovalMode
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function environmentBlock(env: EnvironmentInfo): string {
  return [
    '<environment>',
    `working directory: ${env.cwd}`,
    `platform: ${env.platform}`,
    `date: ${day(env.date)}`,
    `git repository: ${env.isGit ? 'yes' : 'no'}`,
    `commands: ${env.approvalMode === 'auto' ? 'run without asking' : 'each command needs the user\'s approval'}`,
    '</environment>',
  ].join('\n')
}
