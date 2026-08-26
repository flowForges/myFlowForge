import { describe, it, expect } from 'vitest'
import { MAX_IMAGE_BASE64, planPickedImage } from './pickedImage'

// 09:05:07 —— 通用名改名后的时间戳就是这个,断言里写死好看出「到底改成了什么」。
const NOW = new Date(2026, 7, 26, 9, 5, 7)
const b64 = (n: number) => 'A'.repeat(n)

describe('planPickedImage —— 相册挑出来这张图能不能发', () => {
  it('普通一张图:原样放行,字节原封不动带出去', () => {
    const p = planPickedImage({ fileName: 'IMG_0421.HEIC', base64: b64(100) }, NOW)
    expect(p).toEqual({ ok: true, name: 'IMG_0421.HEIC', dataBase64: b64(100) })
  })

  it('★人自己命名过的名字必须原样保留(比我们生成的时间戳有信息量)', () => {
    const p = planPickedImage({ fileName: '设计稿-第二版.png', base64: b64(10) }, NOW)
    expect(p.ok && p.name).toBe('设计稿-第二版.png')
  })

  it('★★相册里连选三张 `image.png`:三个名字必须互不相同,否则等于没有占位符', () => {
    const names = [0, 1, 2].map(
      (i) => planPickedImage({ fileName: 'image.png', base64: b64(10) }, new Date(2026, 7, 26, 9, 5, 7 + i)),
    )
    const got = names.map((p) => (p.ok ? p.name : 'FAIL'))
    expect(got).toEqual(['img-090507.png', 'img-090508.png', 'img-090509.png'])
    expect(new Set(got).size).toBe(3)
  })

  it('★文件名里带路径:只留最后一段,不能让 `..` 把附件写到工作区外面去', () => {
    // 服务端是 `join(dir, name)` —— 原样传过去就是穿出 `.forge/attachments/` 往上写。
    const p = planPickedImage({ fileName: '../../evil.png', base64: b64(10) }, NOW)
    expect(p.ok && p.name).toBe('evil.png')
    expect(p.ok && p.name.includes('..')).toBe(false)
  })

  it('相册没给名字:退到 image.png,于是走通用名那条路改成带时分秒的', () => {
    expect(planPickedImage({ base64: b64(10) }, NOW)).toMatchObject({ ok: true, name: 'img-090507.png' })
    expect(planPickedImage({ fileName: null, base64: b64(10) }, NOW)).toMatchObject({ ok: true, name: 'img-090507.png' })
    expect(planPickedImage({ fileName: '', base64: b64(10) }, NOW)).toMatchObject({ ok: true, name: 'img-090507.png' })
  })

  it('★读不出字节(iCloud 里没下下来):拒绝,而不是存一个 0 字节的附件', () => {
    expect(planPickedImage({ fileName: 'a.png', base64: null }, NOW).ok).toBe(false)
    expect(planPickedImage({ fileName: 'a.png', base64: '' }, NOW).ok).toBe(false)
    const p = planPickedImage({ fileName: 'a.png' }, NOW)
    expect(p.ok).toBe(false)
    expect(p.ok === false && p.why).toContain('没读出内容')
  })

  it('★超过上限:拒绝,并且那句话里要有真实大小,人才知道该怎么办', () => {
    const p = planPickedImage({ fileName: 'huge.png', base64: b64(MAX_IMAGE_BASE64 + 1) }, NOW)
    expect(p.ok).toBe(false)
    // 8,000,001 个 base64 字符 ≈ 6.0MB。数字必须真的算出来,不能是一句笼统的「太大了」。
    expect(p.ok === false && p.why).toMatch(/约 6\.0MB/)
    expect(p.ok === false && p.why).toMatch(/上限 6MB/)
  })

  it('刚好卡在上限上:放行(边界是 > 不是 >=,别把一张正好合规的图也拦掉)', () => {
    expect(planPickedImage({ fileName: 'x.png', base64: b64(MAX_IMAGE_BASE64) }, NOW).ok).toBe(true)
  })
})
