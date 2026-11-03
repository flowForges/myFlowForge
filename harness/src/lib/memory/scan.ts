// 注入扫描(06 spec §10 第 4 条):启发式,只打标记。有标记的不进自动召回、不能自动升级;
// 它拦不住改写过的文本,不是边界。误报要人确认,所以宁可多报
import { cleanText } from '../tools/diagnostics'
import { isRandomToken } from './scrub'

export type Flag = 'override' | 'role' | 'permission' | 'exec' | 'blob'

const OVERRIDE = [
  /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|my|these|those|of)\s+){0,3}(?:previous|prior|above|earlier|preceding|system)\b/i,
  /(?:忽略|无视|忽视|不要理会|不要管|别管|抛开|忘记|忘掉|覆盖)[^\n。!?！？]{0,6}?(?:之前|以前|先前|此前|前面|上面|上述|以上|所有|全部|系统)[^\n。!?！？]{0,8}?(?:指令|指示|命令|规则|提示|要求|设定|说明)/,
]

const ROLE = [
  // 只认顶格(可带引用或列表记号):缩进的 `system: x` 多半是代码里的属性
  /^(?:[>*#-][ \t]*)?(?:system|assistant|developer)[ \t]*:/im,
  /\bSYSTEM[ \t]*:/,
  /\byou are now\b/i,
  // 只认小写:`<User>` 是泛型或组件
  /<\/?(?:system|assistant|user|developer|environment|reminder|memory|executor-notice|checkpoint)\b/,
  /<\|[a-z_]{2,20}\|>|\[\/?INST\]|<<\/?SYS>>/,
  /^(?:[>*#-][ \t]*)?系统[ \t]*[:：]/m,
  /系统(?:提示|消息|指令)[ \t]*[:：]/,
  /你现在是|(?:从现在起|从现在开始)[,，]?你(?:是|就是|将)|你的新身份/,
]

const PERMISSION = [
  /allowUnsandboxedAuto/i,
  /\b(?:skip|bypass|disable|ignore)\s+(?:(?:the|all|any|your)\s+){0,2}approvals?\b/i,
  /\b(?:disable|bypass|turn\s+off|escape)\s+(?:(?:the|your)\s+){0,2}sandbox\b/i,
  /\b(?:user|owner)\s+(?:has\s+)?already\s+approved\b/i,
  /dangerously[-_ ]skip[-_ ]permissions/i,
  /(?:跳过|绕过|免|无需|不用|不需要|关闭)审批|(?:关闭|禁用|绕过|跳出)沙箱/,
]

const EXEC = [
  /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/,
  /\bbase64\s+(?:-d|-D|--decode)\b[^\n|]{0,200}\|/,
]

const BASE64_RUN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{120,}={0,2}/g

function hasBlob(s: string): boolean {
  for (const m of s.matchAll(BASE64_RUN)) if (isRandomToken(m[0])) return true
  return false
}

export function scanInjection(s: string): Flag[] {
  const text = cleanText(s)
  const flags: Flag[] = []
  if (OVERRIDE.some(re => re.test(text))) flags.push('override')
  if (ROLE.some(re => re.test(text))) flags.push('role')
  if (PERMISSION.some(re => re.test(text))) flags.push('permission')
  if (EXEC.some(re => re.test(text))) flags.push('exec')
  if (hasBlob(text)) flags.push('blob')
  return flags
}
