// 从一条【操作系统路径】里取最后一段(目录名/文件名),用来做显示名。
//
// 为什么不用 node:path.basename:渲染层进程里没有 node:path。历史写法是 `p.split('/').pop()`,
// 那在 Windows 上会把**整条路径**当成最后一段返回 —— 工作区会显示成「C:\Users\me\proj」,
// 终端标签同理。Windows 两种分隔符都合法,而且系统 API 返回的路径经常是混着的,所以两种都要认。
//
// 只用于【显示】。真正的路径拼接一律在主进程用 node:path 的 join/dirname。
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}
