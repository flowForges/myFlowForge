/**
 * 「缓存管理」里列的那几项 —— **名字、说明、和它包含哪些 key**。
 *
 * ★★为什么要有这张表,而 `clearLocalData()` 偏偏**不能**用它:
 *  那个函数是「一键清空」,必须**按前缀扫**(见 `localData.ts` 顶部) —— 漏一个 key 的后果是
 *  界面说「已清除」而令牌还躺在手机上,而人会据此把手机借出去。
 *  这张表是给**选择性删除**用的:要让人挑,就得先给每一项起个人话名字,而名字只能手写。
 * ★★所以两者必须同时存在,而且**必须有东西盯着它们不脱节** —— `storageItems.test.ts` 会把
 *  真实存在的 key 和这张表对一遍:表里漏了某个 key,那份数据在「缓存管理」里就**看不见也删不掉**,
 *  而界面上一行不少,看起来一切正常。这正是本仓库最常栽的那种假绿。
 *
 * ★零 import:能在 node 那套 vitest 里直接测(同 `icons.ts` / `wsTile.ts`)。
 */

export type StorageItem = {
  key: string
  /** 列表上那一行的名字。 */
  label: string
  /** 名字下面那行小字。★只写**删了会怎样**,不写「这是什么」—— 后者看名字就知道。 */
  effect: string
  /**
   * 删掉它会不会把你踢下线。
   * ★这一项要在界面上**单独标出来**:其它几项删了只是回到默认,这一项删了要重新扫码配对。
   */
  reconnect?: boolean
}

/**
 * ★顺序 = 界面上从上到下:**代价最大的排最后**。
 *  把「主机和令牌」摆在第一行,等于把最危险的那颗按钮放在拇指最容易够到的地方。
 */
export const STORAGE_ITEMS: readonly StorageItem[] = [
  { key: 'mff.prefs.v1', label: '外观偏好', effect: '主题和字号回到默认' },
  { key: 'mff.expandedWs.v1', label: '列表展开状态', effect: '工作区列表回到默认的收起状态' },
  { key: 'mff.needsYouFolded.v1', label: '「等你」折叠状态', effect: '首页那块重新展开' },
  { key: 'mff.push.v1', label: '推送注册', effect: '收不到推送,要重新打开通知开关' },
  { key: 'mff.activeHost.v1', label: '当前选中的主机', effect: '回到未选状态,主机本身还在' },
  { key: 'mff.hosts.v1', label: '主机和令牌', effect: '所有配过的主机连同令牌一起删掉,要重新扫码配对', reconnect: true },
]

/** 人能读的大小。★0 字节也要显示出来 —— 「没占空间」和「这一项不存在」是两回事。 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
