import { describe, it, expect } from 'vitest'
import { petSrc, builtinAssetUrl } from './petSrc'

describe('petSrc', () => {

  it('★ builtin/ 路径不再解析到随包资源(图片宠物全部按需下载)', () => {
    expect(builtinAssetUrl('builtin/white-catgirl/webp/idle.webp')).toBeUndefined()
  })

  it('non-bundled (downloadable) packs are not in the Vite glob → fall back to forge-pet://', () => {
    // china-dragon etc. moved to on-demand download; they are served from disk, not bundled.
    expect(builtinAssetUrl('builtin/china-dragon/webp/idle.webp')).toBeUndefined()
  })

  it('routes user-uploaded relative paths through the forge-pet protocol', () => {
    expect(petSrc('pet-123/idle.png')).toBe('forge-pet://img/pet-123/idle.png')
  })

  it('passes data URLs through unchanged and returns undefined for empty', () => {
    expect(petSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(petSrc(undefined)).toBeUndefined()
  })
})
