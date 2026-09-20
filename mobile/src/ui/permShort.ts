import type { PermissionMode } from '../../../src/shared/permissions'

/**
 * 权限键上那两个字。
 *
 * ★为什么不用 `permissionModeLabel`:那一份是给**选择单**用的完整说法
 *  (「只读审阅」「自动(工作区)」「完全访问」),摆进 44pt 的键里放不下。
 * ★★为什么**不做成纯图标**:权限是安全相关的 —— 你正要以什么身份把这条消息发出去,
 *  必须一眼读得出是哪一档。一个盾牌图标 + 颜色,只有已经知道配色的人才读得懂。
 * ★三档都是两个字,键宽才能固定。三个字会把输入框再挤窄一截(见 Task 7 的宽度表)。
 */
export function permShort(mode: PermissionMode): string {
  switch (mode) {
    case 'readonly':
      return '只读'
    case 'auto':
      return '自动'
    case 'full':
      return '全权'
  }
}
