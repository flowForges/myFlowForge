import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readImageRef, imageOptsFor, imageBasesFor } from './imageRef'

// 真目录真文件 —— 越界/存在性/体积这几条在假 fs 上验不出真行为(同 fileRef.test.ts)。
let root = '', ws = '', outside = ''
// 1×1 透明 png
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'imgref-'))
  ws = join(root, 'ws')
  outside = join(root, 'outside')
  mkdirSync(join(ws, 'out'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(ws, 'out', 'chart.png'), PNG)
  writeFileSync(join(ws, 'notes.md'), '# hi')
  writeFileSync(join(outside, 'secret.png'), PNG)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('readImageRef', () => {
  it('相对路径 → data URL', () => {
    const r = readImageRef([ws], 'out/chart.png')
    expect(r).toHaveProperty('dataUrl')
    expect((r as { dataUrl: string }).dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('★`./` 开头的相对路径 —— 模型最常这么写', () => {
    expect(readImageRef([ws], './out/chart.png')).toHaveProperty('dataUrl')
  })

  it('★★绝对路径(base 之内)也要能读 —— 老实现用 join(cwd,file) 把它拼成了 <cwd>/Users/… 于是永远「文件不存在」', () => {
    const r = readImageRef([ws], join(ws, 'out', 'chart.png'))
    expect(r).toHaveProperty('dataUrl')
  })

  it('★越界的绝对路径必须拒 —— 手机/远程主机都能连进来,这是个文件读取面', () => {
    expect(readImageRef([ws], join(outside, 'secret.png'))).toEqual({ error: '不在工作区内' })
  })

  it('★`../` 穿越也算越界', () => {
    expect(readImageRef([ws], '../outside/secret.png')).toEqual({ error: '不在工作区内' })
  })

  it('多个 base 按优先级回退(会话 worktree → 工作区根)', () => {
    expect(readImageRef([join(ws, 'out'), ws], 'notes.md')).toEqual({ error: '不是支持的图片格式' })
    expect(readImageRef([join(ws, 'nope'), ws], 'out/chart.png')).toHaveProperty('dataUrl')
  })

  it('不是图片扩展名 → 拒(别把任意文件读成 data URL)', () => {
    expect(readImageRef([ws], 'notes.md')).toEqual({ error: '不是支持的图片格式' })
  })

  it('文件不存在 → 明确说不存在,不说越界', () => {
    expect(readImageRef([ws], 'out/nope.png')).toEqual({ error: '文件不存在' })
  })

  it('没有 base 时不读任何东西', () => {
    expect(readImageRef([], 'out/chart.png')).toEqual({ error: '路径无效' })
  })

  it('体积上限', () => {
    expect(readImageRef([ws], 'out/chart.png', { maxBytes: 10 })).toEqual({ error: '图片过大' })
  })
})

// ★★2026-11 用户报:模型写 `![bcd](/tmp/g9/v/bcd.png)`(文件当时就在),对话里只有 🖼 + 路径。
// 根因:readImageRef 只认工作区 bases 之内 → /tmp 是「不在工作区内」。本机窗口要能看模型产出的任何本地图;
// 远程/手机连进来的调用方仍然只给工作区之内(allowOutside 只在 client.id === 'local' 时由 handler 打开)。
describe('readImageRef — 本机窗口里工作区之外的本地图', () => {
  let home = ''
  beforeAll(() => {
    home = join(root, 'home')
    mkdirSync(join(home, 'pics', 'dir.png'), { recursive: true })
    writeFileSync(join(home, 'pics', 'a.png'), PNG)
    writeFileSync(join(outside, 'fake.png'), 'just some text, not an image')
    writeFileSync(join(outside, 'notes.txt'), 'secret text')
    writeFileSync(join(outside, 'big.png'), Buffer.concat([PNG, Buffer.alloc(64)]))
    symlinkSync(join(outside, 'notes.txt'), join(outside, 'link.png'))
    symlinkSync(join(outside, 'secret.png'), join(ws, 'escape.png'))
    const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])
    writeFileSync(join(outside, 'p.jpg'), JPG)
    writeFileSync(join(outside, 'p.gif'), Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))
    writeFileSync(join(outside, 'p.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))
    writeFileSync(join(outside, 'p.bmp'), Buffer.concat([Buffer.from('BM'), Buffer.alloc(20)]))
  })
  const local = { allowOutside: true, home: () => home }

  it('★★绝对路径(/tmp/… 这类工作区之外)→ data URL', () => {
    expect(readImageRef([ws], join(outside, 'secret.png'), local)).toHaveProperty('dataUrl')
  })
  it('★★file:// URL → data URL', () => {
    expect(readImageRef([ws], 'file://' + join(outside, 'secret.png'), local)).toHaveProperty('dataUrl')
  })
  it('★★~/ 路径按 home 展开', () => {
    expect(readImageRef([ws], '~/pics/a.png', local)).toHaveProperty('dataUrl')
  })
  it('没有 base 时,本机窗口的绝对路径照样能读', () => {
    expect(readImageRef([], join(outside, 'secret.png'), local)).toHaveProperty('dataUrl')
  })
  it('jpg / gif / webp / bmp 都认', () => {
    for (const f of ['p.jpg', 'p.gif', 'p.webp', 'p.bmp']) expect(readImageRef([], join(outside, f), local)).toHaveProperty('dataUrl')
  })
  it('★远程调用方(allowOutside 关)仍然拒工作区之外', () => {
    expect(readImageRef([ws], join(outside, 'secret.png'), { home: () => home })).toEqual({ error: '不在工作区内' })
    expect(readImageRef([ws], '~/pics/a.png', { home: () => home })).toEqual({ error: '不在工作区内' })
  })
  it('.txt 拒', () => {
    expect(readImageRef([], join(outside, 'notes.txt'), local)).toEqual({ error: '不是支持的图片格式' })
  })
  it('★扩展名是 .png 但内容不是图片 → 拒(看魔数)', () => {
    expect(readImageRef([], join(outside, 'fake.png'), local)).toEqual({ error: '不是图片' })
  })
  it('★指向非图片的符号链接(link.png → notes.txt)→ 拒', () => {
    expect(readImageRef([], join(outside, 'link.png'), local)).toHaveProperty('error')
    expect(readImageRef([], join(outside, 'link.png'), local)).not.toHaveProperty('dataUrl')
  })
  it('★★工作区里的符号链接逃到工作区外 → 远程调用方拒', () => {
    expect(readImageRef([ws], 'escape.png')).toEqual({ error: '不在工作区内' })
  })
  it('目录(哪怕叫 dir.png)→ 拒', () => {
    expect(readImageRef([], join(home, 'pics', 'dir.png'), local)).toEqual({ error: '这是个目录' })
  })
  it('文件不存在 → 文件不存在(渲染层退回占位符)', () => {
    expect(readImageRef([], join(outside, 'nope.png'), local)).toEqual({ error: '文件不存在' })
  })
  it('超过体积上限 → 拒', () => {
    expect(readImageRef([], join(outside, 'big.png'), { ...local, maxBytes: PNG.length + 10 })).toEqual({ error: '图片过大' })
  })
  it('路径里带 NUL → 拒', () => {
    expect(readImageRef([], join(outside, 'secret.png') + '\0.png', local)).toEqual({ error: '路径无效' })
  })
  it('本机窗口里相对路径仍按 base 解析,../ 穿越照样拒', () => {
    expect(readImageRef([ws], 'out/chart.png', local)).toHaveProperty('dataUrl')
    expect(readImageRef([ws], '../outside/secret.png', local)).toEqual({ error: '不在工作区内' })
  })
})

describe('imageOptsFor — 谁能读工作区之外', () => {
  it('★只有本机窗口(id === local)放行', () => {
    expect(imageOptsFor({ id: 'local', label: '本机' }).allowOutside).toBe(true)
    expect(imageOptsFor({ id: 'local', label: '本机', fromOverlay: true }).allowOutside).toBe(true)
  })
  it('★远程连接、未知调用方一律不放行', () => {
    expect(imageOptsFor({ id: 'c-123', label: '手机' }).allowOutside).toBe(false)
    expect(imageOptsFor(undefined).allowOutside).toBe(false)
  })
})

// ★★review 2026-11:本机窗口的绝对路径分支以前直接 existsSync(abs)。Windows 上 `![x](//attacker/s/a.png)`
// 被 resolve 成 UNC `\\attacker\s\a.png`,existsSync 就去连 SMB —— NTLM 哈希外泄;macOS 的 /net/<host>/… 会触发自动挂载。
// 这些路径必须在**碰文件系统之前**就拒掉。
describe('readImageRef — 网络路径在碰 fs 之前就拒', () => {
  const touched: string[] = []
  const spyFs = {
    existsSync: (p: string) => { touched.push(p); return true },
    realpathSync: (p: string) => { touched.push(p); return p },
  }
  const win = { allowOutside: true, platform: 'win32' as const, fs: spyFs }
  const mac = { allowOutside: true, platform: 'darwin' as const, fs: spyFs }

  it('★★win32:`//host/share/a.png` → 拒,且不调用 existsSync', () => {
    touched.length = 0
    expect(readImageRef([], '//attacker/s/a.png', win)).toEqual({ error: '路径无效' })
    expect(touched).toEqual([])
  })
  it('★★win32:`\\\\host\\share\\a.png`(UNC 原样)→ 拒', () => {
    touched.length = 0
    expect(readImageRef([], '\\\\attacker\\s\\a.png', win)).toEqual({ error: '路径无效' })
    expect(readImageRef([], 'file:////attacker/s/a.png', win)).toEqual({ error: '路径无效' })
    expect(touched).toEqual([])
  })
  it('★win32:`\\\\?\\` 设备路径、没有盘符的根 → 拒', () => {
    touched.length = 0
    expect(readImageRef([], '\\\\?\\C:\\a.png', win)).not.toHaveProperty('dataUrl')
    expect(readImageRef([], '\\\\.\\pipe\\a.png', win)).toEqual({ error: '路径无效' })
    expect(touched).toEqual([])
  })
  it('win32:本地盘符根照常放行(落到 existsSync)', () => {
    touched.length = 0
    readImageRef([], 'C:\\Users\\me\\a.png', win)
    expect(touched[0]).toBe('C:\\Users\\me\\a.png')
  })
  it('★★darwin:`//host/…`、/net/<host>/…、/Network/… → 拒,不碰 fs', () => {
    touched.length = 0
    expect(readImageRef([], '//attacker/s/a.png', mac)).toEqual({ error: '路径无效' })
    expect(readImageRef([], '/net/attacker/s/a.png', mac)).toEqual({ error: '路径无效' })
    expect(readImageRef([], '/Network/Servers/h/a.png', mac)).toEqual({ error: '路径无效' })
    expect(readImageRef([], '/tmp/../net/attacker/a.png', mac)).toEqual({ error: '路径无效' })
    expect(touched).toEqual([])
  })
  it('darwin:普通绝对路径照常放行', () => {
    touched.length = 0
    readImageRef([], '/tmp/x/a.png', mac)
    expect(touched[0]).toBe('/tmp/x/a.png')
  })
  it('★realpath 解到网络路径也拒(本地符号链接指向 /net/…)', () => {
    const fs = { existsSync: () => true, realpathSync: () => '/net/attacker/a.png' }
    expect(readImageRef([], '/tmp/x/a.png', { ...mac, fs })).toEqual({ error: '路径无效' })
  })
})

// ★review 2026-11:检查和读取以前是三次独立按路径的调用(statSync / openSync 读头 / readFileSync),
// 中间把文件换成指向 ~/.ssh/id_rsa 的符号链接,就能把私钥当 data:image 读出去。现在:O_NOFOLLOW 打开一次,
// fstat 的 dev/ino 必须和 statSync(real) 一致,头和体都从同一个 fd 读。
describe('readImageRef — 检查与读取之间的竞态', () => {
  let dir = ''
  beforeAll(() => {
    dir = join(root, 'race')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ok.png'), PNG)
    writeFileSync(join(dir, 'id_rsa'), Buffer.concat([PNG.subarray(0, 8), Buffer.from('-----BEGIN PRIVATE KEY-----')]))
    symlinkSync(join(dir, 'id_rsa'), join(dir, 'swapped.png'))
  })
  it('★realpath 之后真身被换成符号链接 → O_NOFOLLOW 打开失败,拒', () => {
    // 模拟:realpath 那一刻 swapped.png 还是普通文件(注入 realpath 原样返回),打开时已是符号链接。
    const fs = { realpathSync: (p: string) => p }
    const r = readImageRef([], join(dir, 'swapped.png'), { allowOutside: true, fs })
    expect(r).toEqual({ error: '读取失败' })
  })
  it('★stat 之后文件被换掉(dev/ino 对不上)→ 拒', async () => {
    const real = await import('node:fs')
    const fs = { statSync: (p: string) => real.statSync(p.endsWith('/ok.png') ? join(dir, 'id_rsa') : p) }
    const r = readImageRef([], join(dir, 'ok.png'), { allowOutside: true, fs })
    expect(r).toEqual({ error: '读取失败' })
  })
  it('正常文件仍然读得出(头和体来自同一个 fd)', () => {
    const r = readImageRef([], join(dir, 'ok.png'), { allowOutside: true })
    expect((r as { dataUrl: string }).dataUrl).toBe('data:image/png;base64,' + PNG.toString('base64'))
  })
})

// ★review 2026-11:bases 是调用方传来的。远程客户端可以直接传 bases: ['/'] 把整台机器当「工作区」。
// 非本机调用方的每个 base 都必须落在某个已登记工作区(项目 worktree 都建在工作区目录下)之内,否则整次拒。
describe('imageBasesFor — 远程调用方的 bases 只能是已知工作区', () => {
  const known = () => [ws]
  it('★本机窗口原样放行', () => {
    expect(imageBasesFor({ id: 'local' }, ['/'], known)).toEqual(['/'])
  })
  it('★远程:工作区根、工作区里的 worktree → 放行', () => {
    expect(imageBasesFor({ id: 'c-1' }, [join(ws, 'out'), ws], known)).toEqual([join(ws, 'out'), ws])
  })
  it('★★远程:/、工作区之外、`ws/../outside` → 拒(null)', () => {
    expect(imageBasesFor({ id: 'c-1' }, ['/'], known)).toBeNull()
    expect(imageBasesFor({ id: 'c-1' }, [ws, outside], known)).toBeNull()
    expect(imageBasesFor({ id: 'c-1' }, [join(ws, '..', 'outside')], known)).toBeNull()
    expect(imageBasesFor(undefined, [outside], known)).toBeNull()
  })
  it('★远程:工作区里指向外面的符号链接目录 → 拒', () => {
    symlinkSync(outside, join(ws, 'linkdir'))
    expect(imageBasesFor({ id: 'c-1' }, [join(ws, 'linkdir')], known)).toBeNull()
  })
  it('远程:非字符串 / 相对路径 → 拒', () => {
    expect(imageBasesFor({ id: 'c-1' }, ['out'], known)).toBeNull()
    expect(imageBasesFor({ id: 'c-1' }, [42 as unknown as string], known)).toBeNull()
  })
})
