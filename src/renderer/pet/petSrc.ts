import { petImageUrl } from '@shared/petImageUrl'

// ★ 这里曾经用 Vite glob 把 white-catgirl 的 5 张 animated webp 打进渲染进程 —— 4.3MB,是安装包里最大的
// 一块。现在没有任何图片宠物随包发货:默认形象是内置 SVG「幽灵」(不走这条路),所有图片宠物都从
// flowForges/pet-packs 按需下载、存到用户本地,再通过 forge-pet:// 从磁盘读。
// 保留这个函数是为了老配置:它们的图片路径仍是 'builtin/…',现在一律解析不到,交给 petImageUrl 走磁盘
// (下载回来就能显示),启动迁移则会把仍指着已下架内置宠物的配置回落到幽灵(见 src/main/index.ts)。
export function builtinAssetUrl(_stored: string): string | undefined {
  return undefined   // 不再有随包资源
}

// Resolve a stored pet-image value to a renderer <img> src. Built-in pack paths ('builtin/…') use the
// bundled asset (protocol-independent); everything else (user uploads, data URLs) goes through
// petImageUrl → forge-pet://. Falls back to the protocol URL if a built-in asset isn't found.
export function petSrc(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  if (stored.startsWith('builtin/')) return builtinAssetUrl(stored) ?? petImageUrl(stored)
  return petImageUrl(stored)
}
