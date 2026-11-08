import { createContext } from 'react'

/**
 * 这段 markdown 的作者可信不可信。默认 false = 现状,所有现有调用方行为不变。
 * true(mff-ai 的对话:模型文字可能被注入)时:
 *  - MdImage 不加载远程图(http(s):、//host),改成一条链接,文字是 alt;data: 只放行位图;其他协议只给占位符。
 *  - MdLink 在外链的文字和地址不同时,旁边显示目标的主机名。
 */
export const UntrustedMdCtx = createContext<boolean>(false)

const RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** 远程地址:http(s): 或协议相对的 //host */
export const isRemoteSrc = (src: string): boolean => /^(https?:)?\/\//i.test(src.trim())

/** 不可信时能加载的图:位图 data:,或没有协议的本地路径(仍要 base 才读得到) */
export const isLoadableUntrusted = (src: string): boolean => RASTER_DATA.test(src) || (!SCHEME.test(src) && !isRemoteSrc(src))

/** 外链的主机名;不是外链给 undefined */
export function hostOf(href: string): string | undefined {
  if (!isRemoteSrc(href)) return undefined
  try { return new URL(href, 'https://invalid.invalid/').host || undefined } catch { return undefined }
}
