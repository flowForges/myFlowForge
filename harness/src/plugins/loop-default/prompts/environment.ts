// 用户消息前的提醒块(spec §8.2),只在发给模型的消息里,不写进事件。
// 为了让历史前缀每轮逐字节相同(提示词缓存):
// - <environment> 只由会话字段与 cwd 算出,放在会话第一条用户消息前,每轮重建时原样再放
// - 日期放在每条用户消息前的 <reminder>,取那条 message.user 事件的时间,重建时也不变
import type { ApprovalMode } from '../../../protocol/index'

export interface EnvironmentInfo {
  cwd: string
  platform: NodeJS.Platform
  isGit: boolean
  approvalMode: ApprovalMode
}

export function environmentBlock(env: EnvironmentInfo): string {
  return [
    '<environment>',
    `working directory: ${env.cwd}`,
    `platform: ${env.platform}`,
    `git repository: ${env.isGit ? 'yes' : 'no'}`,
    `commands: ${env.approvalMode === 'auto' ? 'run without asking' : 'each command needs the user\'s approval'}`,
    '</environment>',
  ].join('\n')
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 某条用户消息发出时的日期(本地时区) */
export function dateReminder(ts: number): string {
  return `<reminder>date: ${day(new Date(ts))}</reminder>`
}
