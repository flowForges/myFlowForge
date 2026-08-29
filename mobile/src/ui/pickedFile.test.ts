import { describe, it, expect } from 'vitest'
import { planPickedFile, tooLargeBySize, MAX_FILE_BYTES } from './pickedFile'
import { MAX_IMAGE_BASE64 } from './pickedImage'

const NOW = new Date('2026-08-28T10:00:00Z')
const big = 'A'.repeat(MAX_IMAGE_BASE64 + 1)

describe('挑出来这个文件能不能发', () => {
  it('普通文件放行,名字原样留着', () => {
    const r = planPickedFile({ name: '部署说明.md', dataBase64: 'aGVsbG8=' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name).toContain('部署说明')
  })

  it('★读不出内容 → 拦住并说人话(不能存一个 0 字节的附件)', () => {
    // 不拦的话:chip 照常显示,代理打开是空的 —— 而人以为发过去了。
    const r = planPickedFile({ name: 'a.log', dataBase64: '' }, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.why.length).toBeGreaterThan(8)
  })

  it('★超过上限 → 拦住,而且要报**实际多大**和**上限多少**', () => {
    const r = planPickedFile({ name: 'dump.bin', dataBase64: big }, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.why).toMatch(/MB/)
      expect(r.why).toMatch(/6MB|上限/)
    }
  })

  it('★★上限和图片是**同一条线** —— 它管的是一条 WebSocket 帧能塞多少,跟内容是不是图片无关', () => {
    // 两条线的话,迟早出现「同样大的东西,当图片发得出去、当文件发不出去」。
    const justUnder = 'A'.repeat(MAX_IMAGE_BASE64)
    expect(planPickedFile({ name: 'x.bin', dataBase64: justUnder }, NOW).ok).toBe(true)
  })

  it('★★文件名里的路径必须被剥掉 —— 服务端是 join(dir, name),带一个 ../ 就写到工作区外面去了', () => {
    const r = planPickedFile({ name: '../../../etc/passwd', dataBase64: 'eA==' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).not.toContain('/')
      expect(r.name).not.toContain('..')
      expect(r.name).toContain('passwd')
    }
  })

  it('★反斜杠也要剥(文件选择器在别的平台给的是 Windows 风格的路径)', () => {
    const r = planPickedFile({ name: 'C:\\\\tmp\\\\a.txt', dataBase64: 'eA==' }, NOW)
    if (r.ok) expect(r.name).not.toContain('\\\\')
  })

  it('★撞名要去重 —— 连发两个 `log.txt`,正文里两个占位符一模一样,代理分不清哪句说哪个', () => {
    // ★去重靠的是调用方传进来的「已经用过的名字」,不是这个模块自己记的 —— 见下一条「换一批」。
    const a = planPickedFile({ name: 'log.txt', dataBase64: 'eA==' }, NOW)
    const taken = new Set(a.ok ? [a.name] : [])
    const b = planPickedFile({ name: 'log.txt', dataBase64: 'eQ==' }, new Date(NOW.getTime() + 61_000), taken)
    if (a.ok && b.ok) expect(a.name).not.toBe(b.name)
  })

  it('★★★换一批 takenNames(比如切到了别的会话)→ 不能被上一次调用的残留状态影响,两次都该拿到原名', () => {
    // 这条专门钉「去重状态不许活在模块里」:如果实现内部还留着一个模块级 Set(记住了
    // 上一条用例的 'log.txt'/'log-*.txt'),这里换一个全新名字、每次都传一个全新的空
    // Set,理应两次都拿到原名 —— 一旦这条红了,说明有状态从调用之间偷偷漏出来了。
    const a = planPickedFile({ name: 'notes.txt', dataBase64: 'eA==' }, NOW, new Set())
    const b = planPickedFile({ name: 'notes.txt', dataBase64: 'eQ==' }, new Date(NOW.getTime() + 61_000), new Set())
    expect(a.ok && a.name).toBe('notes.txt')
    expect(b.ok && b.name).toBe('notes.txt')
  })

  it('一个名字都没有 → 兜一个,不能得到一个空文件名', () => {
    const r = planPickedFile({ name: '', dataBase64: 'eA==' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name.length).toBeGreaterThan(0)
  })
})

describe('★★读文件之前的那道门(按 size 字节数,不用先把内容读进内存)', () => {
  it('超过上限 → 拦住,而且要报**实际多大**和**上限多少**', () => {
    const why = tooLargeBySize(MAX_FILE_BYTES + 1)
    expect(why).toMatch(/MB/)
    expect(why).toMatch(/6MB|上限/)
  })

  it('刚好卡在上限上 → 放行(和读后那道门的边界一致)', () => {
    expect(tooLargeBySize(MAX_FILE_BYTES)).toBeNull()
  })

  it('size 缺失(iCloud 未下载 / 某些 provider 给不出来)→ 不拦,交给读后那道门兜底', () => {
    expect(tooLargeBySize(undefined)).toBeNull()
    expect(tooLargeBySize(null)).toBeNull()
  })

  it('★★两道门的措辞必须一字不差 —— 人分不出是哪道门拦的', () => {
    const beforeRead = tooLargeBySize(MAX_FILE_BYTES + 1)
    const big = 'A'.repeat(MAX_IMAGE_BASE64 + 1)
    const afterRead = planPickedFile({ name: 'dump.bin', dataBase64: big }, NOW)
    expect(afterRead.ok).toBe(false)
    if (!afterRead.ok) expect(beforeRead).toBe(afterRead.why)
  })
})
