// 拉 git 来源(09 spec §6.3、M14):git 本身可信,仓库内容不可信。配置全空、环境白名单、检出前先看树。
// 这里不解析、不运行任何东西;落地的只是文件。stderr 只用来判代码,判完就丢
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { isInternalHost } from './hosts'
import { badSegment, cleanPath, TREE_LIMITS } from './tree'
import type { Warning } from './types'

export type FetchError = 'git_not_found' | 'auth_required' | 'too_large' | 'timeout' | 'network' | 'bad_ref' | 'bad_repo' | 'symlink' | 'bad_url' | 'bad_path'

export type FetchResult = { ok: true; commit: string; warnings: Warning[] } | { ok: false; error: FetchError; path?: string }

export interface FetchTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface FetchOpts {
  url: string
  ref?: string
  /** 相对、不含 `..`。给了就只看、只取这个子树,它就是落地后的根 */
  subpath?: string
  /** 不存在或是空目录。成功时是插件根,失败时被删掉 */
  into: string
  /** 空的临时目录,调用方负责删 */
  tmpHome: string
  /** 只从里面取 PATH、LANG、LC_ALL 和代理变量 */
  baseEnv: NodeJS.ProcessEnv
  spawn?: typeof nodeSpawn
  /** 每条 git 的进程组:起来时 (pgid, false),没了之后 (pgid, true) */
  onGroup?: (pgid: number, done: boolean) => void
  timeoutMs?: number
  /** 拉取过程占的磁盘上限(含 .git) */
  maxBytes?: number
  sizeOf?: (dir: string) => number
  /** 只给测试。配置、环境变量、RPC 都改不了 */
  allowFileProtocol?: boolean
  timers?: FetchTimers
}

const HARDENING = [
  'protocol.allow=never',
  'protocol.https.allow=always',
  'http.followRedirects=false',
  'credential.helper=',
  'transfer.fsckObjects=true',
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.attributesFile=/dev/null',
  'core.symlinks=false',
  'core.protectHFS=true',
  'core.protectNTFS=true',
  'submodule.recurse=false',
  // gc 会自己脱离进程组,杀不到
  'gc.auto=0',
  // 新版 git 的 fetch 另起 `git maintenance run --auto --detach`,也会脱离进程组
  'maintenance.auto=false',
]
const ENV_KEEP = ['PATH', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']

const TIMEOUT_MS = 120_000
const MAX_BYTES = 200 * 1024 * 1024
const PROBE_MS = 1000
const LISTING_MAX_BYTES = 4 * 1024 * 1024
/** 和遍历的文件数同一个上限 */
const LISTING_MAX_ROWS = TREE_LIMITS.maxFiles
const STDOUT_MAX = 4096
const STDERR_MAX = 64 * 1024
/** 进程退了但有逃出组的后代拿着管道:不等它 */
const HELD_PIPE_MS = 500
const URL_MAX = 2048
const SUBPATH_MAX = 1024

const HTTPS_URL = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/
const FILE_URL = /^file:\/\/\/[^\s\p{Cc}\p{Cf}\\]*$/u
/** %00-%1F、%7F:解码后是控制字符(CVE-2020-5260 那一类) */
const ENCODED_CONTROL = /%(?:[01][0-9a-f]|7f)/i
const REF = /^[A-Za-z0-9._/-]{1,200}$/
/** 优先于树里任何 .gitattributes:ls-tree 数的是 blob 的大小,`* ident` 能把落盘撑到几十倍,落地的字节也得就是 blob 的字节 */
const NO_ATTRIBUTES = '* -text -eol -ident -filter -working-tree-encoding -crlf\n'
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const LISTING_ROW = /^(\d{6}) (blob|tree|commit) [0-9a-f]{40,64}\s+(\d+|-)\t(.+)$/s

/** 只收不带账号、不带查询串的 https(同意页写的就是取代码的地址,地址里也不存令牌)。`allowFileProtocol` 只多放开绝对的 file:// */
export function checkGitUrl(url: string, o: { allowFileProtocol?: boolean } = {}): { ok: true } | { ok: false; error: 'bad_url' } {
  const bad = { ok: false, error: 'bad_url' } as const
  if (typeof url !== 'string' || url.length > URL_MAX) return bad
  if (o.allowFileProtocol === true && FILE_URL.test(url)) return { ok: true }
  if (!HTTPS_URL.test(url) || ENCODED_CONTROL.test(url)) return bad
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return bad
  }
  return isInternalHost(host) ? bad : { ok: true }
}

export const checkRef = (ref: string) => REF.test(ref) && !ref.startsWith('-') && !ref.includes('..')

/** 合规的子路径去掉结尾斜杠后返回,否则 undefined */
export function normalizeSubpath(subpath: string): string | undefined {
  const s = subpath.endsWith('/') ? subpath.slice(0, -1) : subpath
  if (s.length === 0 || s.length > SUBPATH_MAX || s.startsWith('-') || s.startsWith(':')) return undefined
  const segs = s.split('/')
  if (segs.length > TREE_LIMITS.maxDepth || segs.some(p => badSegment(p) || p.toLowerCase() === '.git')) return undefined
  return s
}

function buildEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of ENV_KEEP) if (base[k] !== undefined) env[k] = base[k]
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    // 不向上找仓库:init 没成功时,落在别人的仓库里干活
    GIT_DIR: '.git',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_LITERAL_PATHSPECS: '1',
    // 下面的匹配靠英文:LANG、LC_ALL 照传,翻译关掉
    LANGUAGE: 'en',
  }
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

/** 地址和主机名是用户给的、对方起的:里面的 fsck、corrupt 不算 git 说的话。大小写都去,git 和 curl 不一定照原样打印 */
function withoutAddress(stderr: string, url: string): string {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    /* file:// 和坏地址没有主机名 */
  }
  return [url, host].filter(t => t !== '').reduce((text, t) => text.replace(new RegExp(escapeRe(t), 'gi'), ' '), stderr)
}

/**
 * 从 stderr 判代码。对方能写进来的都不算:sideband 的 `remote:` 行、地址;
 * ERR 包打印成 `fatal: remote error: <对方的文字>`,文字里的换行还能造出没有前缀的下一行,所以有这一行就不再往下看
 */
function codeOf(stderr: string, url: string): FetchError {
  const text = withoutAddress(stderr, url)
    .split('\n')
    .filter(l => !l.startsWith('remote:'))
    .join('\n')
  if (/fatal: remote error:/i.test(text)) return /fatal: remote error:[^\n]*not our ref/i.test(text) ? 'bad_ref' : 'network'
  if (/could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|returned error: 40[13]\b/i.test(text)) return 'auth_required'
  if (/couldn't find remote ref|Remote branch .* not found|not our ref|unadvertised object|invalid refspec/i.test(text)) return 'bad_ref'
  if (/fsck|index-pack|unpack-objects|bad object|bad pack|corrupt|malformed|did not send all necessary objects|does not appear to be a git repository|not a git repository|is this a git repository/i.test(text)) return 'bad_repo'
  return 'network'
}

/** 目录占的字节(lstat,不跟随);超过 stopAt 就不再数 */
function defaultSizeOf(root: string, stopAt: number): number {
  let total = 0
  const visit = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (total > stopAt) return
      const p = join(dir, name)
      let st: Stats
      try {
        st = lstatSync(p)
      } catch {
        continue // git 的临时文件来去很快
      }
      if (st.isDirectory()) visit(p)
      else total += st.size
    }
  }
  visit(root)
  return total
}

/** 不存在就建;是链接、不是目录、已有内容都是调用方的错:一个字节不碰 */
function prepareInto(into: string): void {
  let st: Stats
  try {
    st = lstatSync(into)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    mkdirSync(into, { recursive: true })
    return
  }
  if (!st.isDirectory() || readdirSync(into).length > 0) throw new Error('fetchGit: into must be new or an empty directory')
}

type Listed = { ok: true; warnings: Warning[] } | { ok: false; error: FetchError; path?: string }

/** 读 `ls-tree -r -z -l`:链接拒并点名,子模块记下,大小在落盘之前算 */
function checkListing(listing: Buffer, subpath: string | undefined): Listed {
  const rows = listing.toString('utf8').split('\0').filter(r => r !== '')
  const prefix = subpath === undefined ? '' : `${subpath}/`
  let symlink: string | undefined
  let tooLarge = false
  let bytes = 0
  let submodule = false
  let seen = false
  for (const row of rows) {
    const m = LISTING_ROW.exec(row)
    if (!m) return { ok: false, error: 'bad_repo' }
    const [, mode, type, size, path] = m as unknown as [string, string, string, string, string]
    if (subpath !== undefined && path !== subpath && !path.startsWith(prefix)) return { ok: false, error: 'bad_repo' }
    seen = true
    if (mode === '120000') {
      symlink ??= path
      continue
    }
    if (path === subpath) return { ok: false, error: 'bad_path' }
    if (path.split('/').some(s => badSegment(s) || s.toLowerCase() === '.git')) return { ok: false, error: 'bad_repo' }
    if (mode === '160000' && type === 'commit') {
      submodule = true
    } else if (/^100[0-7]{3}$/.test(mode) && type === 'blob' && size !== '-') {
      if (path === `${prefix}.gitmodules`) submodule = true
      bytes += Number(size)
      if (Number(size) > TREE_LIMITS.maxFileBytes || bytes > TREE_LIMITS.maxBytes) tooLarge = true
    } else {
      return { ok: false, error: 'bad_repo' }
    }
  }
  if (symlink !== undefined) return { ok: false, error: 'symlink', path: cleanPath(symlink) }
  if (tooLarge) return { ok: false, error: 'too_large' }
  if (subpath !== undefined && !seen) return { ok: false, error: 'bad_path' }
  return { ok: true, warnings: submodule ? ['submodules_skipped'] : [] }
}

/** 子树变成根:别的全删 */
function promote(into: string, subpath: string): void {
  const hold = `.mff-sub-${randomBytes(8).toString('hex')}`
  renameSync(join(into, subpath), join(into, hold))
  for (const name of readdirSync(into)) if (name !== hold) rmSync(join(into, name), { recursive: true, force: true })
  for (const name of readdirSync(join(into, hold))) renameSync(join(into, hold, name), join(into, name))
  rmdirSync(join(into, hold))
}

interface Ran {
  /** 起不来(git 不在 PATH 上) */
  missing: boolean
  code: number | null
  stdout: Buffer
  stderr: string
}

export async function fetchGit(o: FetchOpts): Promise<FetchResult> {
  if (!checkGitUrl(o.url, { allowFileProtocol: o.allowFileProtocol === true }).ok) return { ok: false, error: 'bad_url' }
  if (o.ref !== undefined && !checkRef(o.ref)) return { ok: false, error: 'bad_ref' }
  const subpath = o.subpath === undefined ? undefined : normalizeSubpath(o.subpath)
  if (o.subpath !== undefined && subpath === undefined) return { ok: false, error: 'bad_path' }

  mkdirSync(o.tmpHome, { recursive: true })
  prepareInto(o.into)

  const spawn = o.spawn ?? nodeSpawn
  const timers = o.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h as NodeJS.Timeout) }
  const maxBytes = o.maxBytes ?? MAX_BYTES
  const sizeOf = o.sizeOf ?? ((dir: string) => defaultSizeOf(dir, maxBytes))
  const flags = [...HARDENING, ...(o.allowFileProtocol === true ? ['protocol.file.allow=always'] : [])].flatMap(f => ['-c', f])
  const env = buildEnv(o.baseEnv, o.tmpHome)

  let stop: 'timeout' | 'too_large' | undefined
  let killCurrent: (() => void) | undefined
  const abort = (why: 'timeout' | 'too_large') => {
    stop ??= why
    killCurrent?.()
  }
  const note = (pgid: number, ended: boolean) => {
    try {
      o.onGroup?.(pgid, ended)
    } catch {
      /* 登记失败不能把拉取留在半路 */
    }
  }

  const git = (args: string[], listing = false) =>
    new Promise<Ran>(resolve => {
      const child = spawn('git', [...flags, ...args], { cwd: o.into, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      const pid = child.pid
      const killGroup = () => {
        if (pid === undefined) return
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      const out: Buffer[] = []
      let outBytes = 0
      let rows = 0
      let stderr = ''
      let grace: NodeJS.Timeout | undefined
      let finished = false
      const finish = (code: number | null, missing: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(grace)
        killCurrent = undefined
        // 组长退了,组里可能还有后代
        killGroup()
        if (pid !== undefined) note(pid, true)
        resolve({ missing, code, stdout: Buffer.concat(out), stderr })
      }
      killCurrent = killGroup
      if (pid !== undefined) note(pid, false)
      child.stdout!.on('data', (chunk: Buffer) => {
        outBytes += chunk.length
        if (listing) {
          for (const byte of chunk) if (byte === 0) rows++
          if (outBytes > LISTING_MAX_BYTES || rows > LISTING_MAX_ROWS) abort('too_large')
          else out.push(chunk)
        } else if (outBytes <= STDOUT_MAX) {
          out.push(chunk)
        }
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_MAX)
      })
      child.stdout!.on('error', () => {})
      child.stderr!.on('error', () => {})
      child.on('error', () => finish(null, true))
      child.on('exit', code => {
        grace = setTimeout(() => {
          child.stdout!.destroy()
          child.stderr!.destroy()
          finish(code, false)
        }, HELD_PIPE_MS)
      })
      child.on('close', code => finish(code, false))
    })

  const measure = () => {
    if (stop) return
    try {
      if (sizeOf(o.into) > maxBytes) abort('too_large')
    } catch {
      abort('too_large') // 量不了就当超了
    }
  }

  let probe: unknown
  const tick = () => {
    measure()
    if (!stop) probe = timers.setTimeout(tick, PROBE_MS)
  }
  const deadline = timers.setTimeout(() => abort('timeout'), o.timeoutMs ?? TIMEOUT_MS)
  probe = timers.setTimeout(tick, PROBE_MS)

  const fail = (error: FetchError, path?: string): FetchResult => {
    try {
      rmSync(o.into, { recursive: true, force: true })
    } catch {
      /* 暂存区启动时会清 */
    }
    return { ok: false, error, ...(path !== undefined && { path }) }
  }

  try {
    const init = await git(['init', '--template='])
    if (stop) return fail(stop)
    if (init.missing || /xcrun: error|xcode-select|developer tools/i.test(init.stderr)) return fail('git_not_found')
    if (init.code !== 0) return fail('bad_repo')
    mkdirSync(join(o.into, '.git', 'info'), { recursive: true })
    writeFileSync(join(o.into, '.git', 'info', 'attributes'), NO_ATTRIBUTES)

    const fetched = await git(['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', o.url, o.ref ?? 'HEAD'])
    if (stop) return fail(stop)
    if (fetched.missing) return fail('git_not_found')
    if (fetched.code !== 0) return fail(codeOf(fetched.stderr, o.url))
    measure()
    if (stop) return fail(stop)

    const parsed = await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    if (stop) return fail(stop)
    if (parsed.code !== 0) return fail('bad_ref')
    const commit = parsed.stdout.toString('utf8').trim()
    if (!SHA.test(commit)) return fail('bad_repo')

    const listed = await git(['ls-tree', '-r', '-z', '-l', 'FETCH_HEAD', ...(subpath === undefined ? [] : ['--', subpath])], true)
    if (stop) return fail(stop)
    if (listed.code !== 0) return fail('bad_repo')
    const checked = checkListing(listed.stdout, subpath)
    if (!checked.ok) return fail(checked.error, checked.path)

    // 给了子路径只取子路径:树外的炸弹上面没数,这里也不能落盘
    const out = await git(subpath === undefined ? ['checkout', '--detach', 'FETCH_HEAD', '--'] : ['checkout', 'FETCH_HEAD', '--', subpath])
    if (stop) return fail(stop)
    if (out.code !== 0) return fail('bad_repo')
    measure()
    if (stop) return fail(stop)

    try {
      rmSync(join(o.into, '.git'), { recursive: true, force: true })
      if (subpath !== undefined) promote(o.into, subpath)
    } catch {
      return fail('bad_repo')
    }
    return { ok: true, commit, warnings: checked.warnings }
  } catch (e) {
    fail('bad_repo')
    throw e
  } finally {
    timers.clearTimeout(deadline)
    timers.clearTimeout(probe)
  }
}
