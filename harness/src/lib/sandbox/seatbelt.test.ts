import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sandboxExecArgs, seatbeltProfile, type SeatbeltParams } from './seatbelt'

// 纯测试:把生成的配置按 SBPL 的读法解析成树再断言,不靠子串碰运气

type Node = string | { s: string } | Node[]

/** 最小的 SBPL 读取器:括号、带 \" \\ \n \t 转义的字符串、其余为原子;字符串外出现引号或不配对的括号就抛错 */
function parseSbpl(src: string): Node[] {
  const stack: Node[][] = [[]]
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ';') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (/\s/.test(c)) { i++; continue }
    if (c === '(') { const n: Node[] = []; stack[stack.length - 1].push(n); stack.push(n); i++; continue }
    if (c === ')') { if (stack.length === 1) throw new Error(`unbalanced ) at ${i}`); stack.pop(); i++; continue }
    if (c === '"') {
      let s = ''
      i++
      for (;;) {
        if (i >= src.length) throw new Error('unterminated string')
        const d = src[i]
        if (d === '"') { i++; break }
        if (d === '\\') {
          const e = src[i + 1]
          const map: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t' }
          if (!(e in map)) throw new Error(`escape \\${e} that SBPL does not decode`)
          s += map[e]; i += 2; continue
        }
        if (d.charCodeAt(0) < 0x20) throw new Error('raw control char in string')
        s += d; i++
      }
      stack[stack.length - 1].push({ s })
      continue
    }
    let a = ''
    while (i < src.length && !/[\s()";]/.test(src[i])) a += src[i++]
    if (src[i] === '"') throw new Error(`quote inside atom ${a}`)
    stack[stack.length - 1].push(a)
  }
  if (stack.length !== 1) throw new Error('unbalanced (')
  return stack[0]
}

interface Rule { index: number; action: string; ops: string[]; filters: Node[][] }

/** 顶层 (allow|deny op... filter...) */
function rules(profile: string): Rule[] {
  return parseSbpl(profile).flatMap((n, index) => {
    if (!Array.isArray(n) || (n[0] !== 'allow' && n[0] !== 'deny')) return []
    const ops = n.slice(1).filter((x): x is string => typeof x === 'string')
    const filters = n.slice(1).filter((x): x is Node[] => Array.isArray(x))
    return [{ index, action: n[0] as string, ops, filters }]
  })
}

/** 规则里某种 filter(literal/subpath/regex)的字符串参数 */
function args(r: Rule, kind: string): string[] {
  const out: string[] = []
  const walk = (f: Node[]) => {
    if (f[0] === kind) for (const x of f.slice(1)) if (typeof x === 'object' && !Array.isArray(x)) out.push(x.s)
    for (const x of f) if (Array.isArray(x)) walk(x)
  }
  r.filters.forEach(walk)
  return out
}

const writeOps = (r: Rule) => r.ops.some(o => o.startsWith('file-write'))
const readOps = (r: Rule) => r.ops.some(o => o.startsWith('file-read'))

const tmpRoots: string[] = []
afterAll(() => { for (const d of tmpRoots) rmSync(d, { recursive: true, force: true }) })

// 路径不存在时 realpath 回落到原样,纯测试用不存在的绝对路径即可
const base = '/nonexistent-mffai-test'
function params(o: Partial<SeatbeltParams> = {}): SeatbeltParams {
  const data = `${base}/data`
  return {
    writable: [`${base}/cwd`, `${base}/cwd/.git`, `${data}/sessions/s/tmp`],
    gitDirs: [`${base}/cwd/.git`],
    denyRead: [`${base}/home/.ssh`, data],
    reAllowRead: [`${data}/sessions/s/spill`, `${data}/sessions/s/tmp`],
    denyWrite: [`${base}/home/.ssh`, data, `${base}/home/.zshrc`],
    reAllowWrite: [`${data}/sessions/s/tmp`],
    moveBlock: [`${base}/home/.ssh`, data, `${base}/cwd/sub`],
    proxyPort: 41234,
    ...o,
  }
}

describe('seatbeltProfile', () => {
  it('starts with (version 1) (deny default) and parses cleanly', () => {
    const tree = parseSbpl(seatbeltProfile(params()))
    expect(tree[0]).toEqual(['version', '1'])
    expect(tree[1]).toEqual(['deny', 'default'])
  })

  it('never allows default, lsopen or apple events', () => {
    const p = seatbeltProfile(params({ allowLoopback: true }))
    expect(p).not.toMatch(/\(allow default\)/)
    expect(p).not.toContain('lsopen')
    expect(p).not.toContain('appleevent-send')
    expect(rules(p).some(r => r.action === 'allow' && r.ops.includes('default'))).toBe(false)
  })

  it('allows sysctl-read for hw.* and named kern.* only, never the process table (R1 revised)', () => {
    const rs = rules(seatbeltProfile(params())).filter(r => r.ops.includes('sysctl-read'))
    expect(rs).toHaveLength(1)
    expect(rs[0].action).toBe('allow')
    expect(rs[0].filters.length).toBeGreaterThan(0)
    const prefixes = args(rs[0], 'sysctl-name-prefix')
    const names = args(rs[0], 'sysctl-name')
    expect(prefixes).toContain('hw.')
    expect(names).toContain('kern.osrelease')
    const covers = (n: string) => names.includes(n) || prefixes.some(x => n.startsWith(x))
    for (const n of ['kern.proc.all', 'kern.proc.pid.1', 'kern.procargs2', 'kern.uuid']) expect(covers(n), n).toBe(false)
    expect(prefixes.some(x => x.startsWith('kern'))).toBe(false)
  })

  it('limits named POSIX shm and semaphores to the runtimes\' own prefixes (I1)', () => {
    const rs = rules(seatbeltProfile(params()))
    const shm = rs.filter(r => r.ops.includes('ipc-posix-shm'))
    const sem = rs.filter(r => r.ops.includes('ipc-posix-sem'))
    expect(shm).toHaveLength(1)
    expect(sem).toHaveLength(1)
    expect(args(shm[0], 'ipc-posix-name-prefix')).toEqual(['/psm_'])
    expect(args(shm[0], 'ipc-posix-name')).toEqual(['apple.shm.notification_center'])
    expect(args(sem[0], 'ipc-posix-name-prefix')).toEqual(['/mp-'])
    expect(rs.some(r => r.ops.some(o => o.startsWith('ipc-posix')) && r.filters.length === 0)).toBe(false)
  })

  it('gives no ioctl on /dev/tty (TIOCSTI)', () => {
    const rs = rules(seatbeltProfile(params())).filter(r => r.ops.includes('file-ioctl'))
    expect(rs).toHaveLength(1)
    expect(args(rs[0], 'literal')).not.toContain('/dev/tty')
  })

  it('limits signal and process-info to the same sandbox', () => {
    const rs = rules(seatbeltProfile(params()))
    for (const op of ['signal', 'process-info*']) {
      const r = rs.filter(x => x.action === 'allow' && x.ops.includes(op))
      expect(r).toHaveLength(1)
      expect(r[0].filters).toEqual([['target', 'same-sandbox']])
    }
  })

  it('has exactly one network-outbound allow, for localhost:<proxyPort>', () => {
    const rs = rules(seatbeltProfile(params())).filter(r => r.action === 'allow' && r.ops.some(o => o.startsWith('network')))
    expect(rs).toHaveLength(1)
    expect(rs[0].ops).toEqual(['network-outbound'])
    expect(rs[0].filters).toEqual([['remote', 'ip', { s: 'localhost:41234' }]])
  })

  it('has no network allow without a proxy port', () => {
    const rs = rules(seatbeltProfile(params({ proxyPort: undefined })))
    expect(rs.some(r => r.action === 'allow' && r.ops.some(o => o.startsWith('network')))).toBe(false)
  })

  it('never allows unix sockets', () => {
    const p = seatbeltProfile(params({ allowLoopback: true }))
    expect(p).not.toMatch(/\(remote unix|\(local unix|unix-socket|network\*/)
  })

  it('rejects a bad proxy port', () => {
    for (const port of [0, -1, 65536, 1.5, NaN]) expect(() => seatbeltProfile(params({ proxyPort: port }))).toThrow()
  })

  it('allowLoopback adds bind/inbound/outbound on localhost:*; absent without', () => {
    const on = rules(seatbeltProfile(params({ allowLoopback: true }))).filter(r => r.action === 'allow' && r.ops.some(o => o.startsWith('network')))
    for (const [op, dir] of [['network-outbound', 'remote'], ['network-bind', 'local'], ['network-inbound', 'local']]) {
      expect(on.some(r => r.ops.join() === op && JSON.stringify(r.filters) === JSON.stringify([[dir, 'ip', { s: 'localhost:*' }]]))).toBe(true)
    }
    const off = seatbeltProfile(params())
    expect(off).not.toContain('network-bind')
    expect(off).not.toContain('network-inbound')
    expect(off).not.toContain('localhost:*')
  })

  it('escapes " and \\ so a path cannot inject rules', () => {
    const evil = `${base}/x") (allow file-write* (subpath "/") ; \\"`
    const p = seatbeltProfile(params({ writable: [evil], denyRead: [evil], moveBlock: [evil] }))
    const rs = rules(p)
    // 解析出来的字符串就是原路径,一个字也没多
    const w = rs.find(r => r.action === 'allow' && writeOps(r) && args(r, 'subpath').includes(evil))
    expect(w).toBeDefined()
    // 没有冒出一条放行根目录的规则
    expect(rs.some(r => r.action === 'allow' && args(r, 'subpath').includes('/'))).toBe(false)
    expect(rs.some(r => r.action === 'allow' && writeOps(r) && r.filters.length === 0)).toBe(false)
    // gitDir 正则里同样只是数据
    const g = seatbeltProfile(params({ gitDirs: [`${base}/r"e\\g(x)/.git`] }))
    expect(() => parseSbpl(g)).not.toThrow()
    expect(g).not.toContain('#"')
  })

  it('rejects paths with control chars, lone surrogates, or that are relative', () => {
    for (const bad of [`${base}/a\nb`, `${base}/a\u0001b`, `${base}/a\u007fb`, `${base}/a\ud800b`, 'rel/path', '']) {
      expect(() => seatbeltProfile(params({ denyRead: [bad] }))).toThrow(/path/)
      expect(() => seatbeltProfile(params({ gitDirs: [bad] }))).toThrow(/path/)
    }
    expect(() => seatbeltProfile(params({ cwdGitFile: `${base}/a\tb/.git` }))).toThrow(/path/)
  })

  it("rejects '..' segments (lexical folding would skip symlinks, M1)", () => {
    for (const bad of [`${base}/a/../home/.aws`, `${base}/a/..`, `${base}/..`]) {
      for (const k of ['writable', 'gitDirs', 'denyRead', 'reAllowRead', 'denyWrite', 'reAllowWrite', 'moveBlock'] as const) {
        expect(() => seatbeltProfile(params({ [k]: [bad] })), k).toThrow(/'\.\.'/)
      }
      expect(() => seatbeltProfile(params({ cwdGitFile: bad }))).toThrow(/'\.\.'/)
    }
    // 只是名字里含两个点的段照常接受
    expect(() => seatbeltProfile(params({ denyRead: [`${base}/a..b/..c`] }))).not.toThrow()
  })

  it('normalises dot segments, double and trailing slashes', () => {
    const p = seatbeltProfile(params({ denyRead: [`${base}/./home//.aws/`] }))
    const r = rules(p).find(x => x.action === 'deny' && readOps(x))!
    expect(args(r, 'subpath')).toContain(`${base}/home/.aws`)
    expect(p).not.toContain('/./')
  })

  it('escapes every regex metachar in gitDir regexes', () => {
    const g = `${base}/a.b+c*d?e(f)g[h]i{j}k|l^m$n\\o/.git`
    const rs = rules(seatbeltProfile(params({ gitDirs: [g], writable: [g] })))
    const regexes = rs.filter(r => r.action === 'deny' && writeOps(r)).flatMap(r => args(r, 'regex')).filter(x => x.startsWith('^/'))
    expect(regexes.length).toBeGreaterThan(0)
    const wt = regexes.map(x => new RegExp(x))
    expect(wt.some(re => re.test(`${g}/worktrees/w1/gitdir`))).toBe(true)
    expect(wt.some(re => re.test(`${g}/modules/sub/hooks/pre-commit`))).toBe(true)
    expect(wt.some(re => re.test(`${g}/modules/a/b/config`))).toBe(true)
    // 元字符必须按字面匹配:把 . 换成 X 就不该命中
    const variant = g.replace('a.b', 'aXb').replace('b+c', 'bbc')
    for (const re of wt) {
      expect(re.test(`${variant}/worktrees/w1/gitdir`)).toBe(false)
      expect(re.test(`${variant}/modules/sub/hooks/x`)).toBe(false)
    }
    // 不拒 gitDir 里的普通文件
    for (const re of wt) {
      expect(re.test(`${g}/objects/ab/cd`)).toBe(false)
      expect(re.test(`${g}/index`)).toBe(false)
    }
  })

  it('denies gitDir/hooks and config after allowing gitDir (R4 order)', () => {
    const rs = rules(seatbeltProfile(params()))
    const allowGit = rs.find(r => r.action === 'allow' && writeOps(r) && args(r, 'subpath').includes(`${base}/cwd/.git`))!
    const denyHooks = rs.find(r => r.action === 'deny' && writeOps(r) && args(r, 'subpath').includes(`${base}/cwd/.git/hooks`))!
    const denyConfig = rs.find(r => r.action === 'deny' && writeOps(r) && args(r, 'literal').includes(`${base}/cwd/.git/config`))!
    expect(allowGit).toBeDefined()
    expect(denyHooks.index).toBeGreaterThan(allowGit.index)
    expect(denyConfig.index).toBeGreaterThan(allowGit.index)
    expect(rs.some(r => r.action === 'deny' && writeOps(r) && args(r, 'literal').includes(`${base}/cwd/.git/config.worktree`))).toBe(true)
  })

  it('denies the worktree .git file when cwdGitFile is set', () => {
    const rs = rules(seatbeltProfile(params({ cwdGitFile: `${base}/cwd/.git` })))
    expect(rs.some(r => r.action === 'deny' && r.ops.includes('file-write*') && args(r, 'literal').includes(`${base}/cwd/.git`))).toBe(true)
    expect(rs.some(r => r.action === 'deny' && r.ops.includes('file-write-unlink') && args(r, 'literal').includes(`${base}/cwd/.git`))).toBe(true)
  })

  it('denies nested .git/hooks|config anywhere', () => {
    const rs = rules(seatbeltProfile(params()))
    const rx = rs.filter(r => r.action === 'deny' && writeOps(r)).flatMap(r => args(r, 'regex')).map(x => new RegExp(x))
    expect(rx.some(re => re.test('/any/where/vendor/.git/hooks/post-checkout'))).toBe(true)
    expect(rx.some(re => re.test('/any/where/vendor/.git/config'))).toBe(true)
  })

  it('re-allows spill read after the dataDir read deny', () => {
    const rs = rules(seatbeltProfile(params()))
    const deny = rs.find(r => r.action === 'deny' && readOps(r) && args(r, 'subpath').includes(`${base}/data`))!
    const spill = rs.find(r => r.action === 'allow' && readOps(r) && args(r, 'subpath').includes(`${base}/data/sessions/s/spill`))!
    expect(deny).toBeDefined()
    expect(spill.index).toBeGreaterThan(deny.index)
    const allowAll = rs.find(r => r.action === 'allow' && r.ops.join() === 'file-read*' && r.filters.length === 0)!
    expect(deny.index).toBeGreaterThan(allowAll.index)
  })

  it('re-allows tmp write after the dataDir write deny (R3); spill is never writable (R2)', () => {
    const rs = rules(seatbeltProfile(params()))
    const deny = rs.find(r => r.action === 'deny' && r.ops.includes('file-write*') && args(r, 'subpath').includes(`${base}/data`))!
    const tmpAllows = rs.filter(r => r.action === 'allow' && writeOps(r) && args(r, 'subpath').includes(`${base}/data/sessions/s/tmp`))
    expect(deny).toBeDefined()
    expect(Math.max(...tmpAllows.map(r => r.index))).toBeGreaterThan(deny.index)
    // 最后一条提到 tmp 的写规则是放行
    const lastTouch = rs.filter(r => writeOps(r) && args(r, 'subpath').includes(`${base}/data/sessions/s/tmp`)).pop()!
    expect(lastTouch.action).toBe('allow')
    const spill = `${base}/data/sessions/s/spill`
    expect(rs.some(r => r.action === 'allow' && writeOps(r) && [...args(r, 'subpath'), ...args(r, 'literal'), ...args(r, 'regex')].some(x => x.includes(spill)))).toBe(false)
  })

  it('move-blocks every gitDir, its hooks and config, cwdGitFile and moveBlock, last (R4)', () => {
    const rs = rules(seatbeltProfile(params({ cwdGitFile: `${base}/cwd/.git` })))
    const mb = rs.filter(r => r.action === 'deny' && r.ops.includes('file-write-unlink'))
    expect(mb).toHaveLength(1)
    expect(mb[0].ops).toEqual(['file-write-unlink', 'file-write-create'])
    const lits = args(mb[0], 'literal')
    for (const p of [`${base}/cwd/.git`, `${base}/cwd/.git/hooks`, `${base}/cwd/.git/config`, `${base}/home/.ssh`, `${base}/data`, `${base}/cwd/sub`]) expect(lits).toContain(p)
    // 在所有写放行之后
    const lastAllow = Math.max(...rs.filter(r => r.action === 'allow' && writeOps(r)).map(r => r.index))
    expect(mb[0].index).toBeGreaterThan(lastAllow)
  })

  it('emits both literal and realpath spellings', () => {
    const root = mkdtempSync(join(tmpdir(), 'mffai-sb-'))
    tmpRoots.push(root)
    const real = realpathSync(root)
    mkdirSync(join(root, 'cwd'))
    const missing = join(root, 'nope', 'deeper') // 不存在:realpath 取最深的存在祖先再接上尾巴
    const rs = rules(seatbeltProfile(params({ writable: [join(root, 'cwd')], denyRead: [missing] })))
    const w = rs.find(r => r.action === 'allow' && writeOps(r) && args(r, 'subpath').includes(join(root, 'cwd')))!
    const d = rs.find(r => r.action === 'deny' && readOps(r) && args(r, 'subpath').includes(missing))!
    if (real !== root) {
      expect(args(w, 'subpath')).toContain(join(real, 'cwd'))
      expect(args(d, 'subpath')).toContain(join(real, 'nope', 'deeper'))
    }
  })

  it('allows only the listed mach services', () => {
    const rs = rules(seatbeltProfile(params()))
    const mach = rs.filter(r => r.action === 'allow' && r.ops.includes('mach-lookup'))
    expect(mach).toHaveLength(1)
    const names = args(mach[0], 'global-name')
    expect(names).toContain('com.apple.trustd.agent')
    expect(names.some(n => /lsd|launchservices|coreservices\.launch|appleevents|SecurityServer|securityd|mDNSResponder|launchd|pasteboard/i.test(n))).toBe(false)
  })
})

describe('sandboxExecArgs', () => {
  it('runs /bin/sh -c under sandbox-exec -p', () => {
    expect(sandboxExecArgs('(version 1)', 'echo hi')).toEqual({ file: '/usr/bin/sandbox-exec', args: ['-p', '(version 1)', '/bin/sh', '-c', 'echo hi'] })
  })
})
