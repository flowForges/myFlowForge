// Windows 体检:把「我在 mac 上只能猜」的那些事实,一次性从真机上抓回来。
//
//   node scripts/win-doctor.mjs          # 人看的报告
//   node scripts/win-doctor.mjs > d.txt  # 存下来贴给 Claude
//
// 只读:不装东西、不改注册表、不写任何文件。可以放心跑。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openerTemplates } from './openerTemplates.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = []
const say = (s = '') => out.push(s)
const h = (t) => { say(''); say('── ' + t + ' ' + '─'.repeat(Math.max(0, 66 - t.length))) }
const ok = (s) => '  ✅ ' + s
const no = (s) => '  ❌ ' + s
const hm = (s) => '  ⚠️  ' + s

const run = (cmd, args) => {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }) } }
  catch (e) { return { ok: false, out: String(e?.stdout ?? '') + String(e?.stderr ?? e?.message ?? '') } }
}

// ── 0. 环境 ───────────────────────────────────────────────────────────────────
h('环境')
say(`  platform=${process.platform} arch=${process.arch} node=${process.version}`)
say(`  homedir=${homedir()}`)
say(`  tmpdir=${tmpdir()}`)
for (const k of ['LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'CLAUDE_CONFIG_DIR']) {
  say(`  %${k}% = ${process.env[k] ?? '(未设置)'}`)
}
if (process.platform !== 'win32') say(hm('这不是 Windows —— 下面的检查大多没意义,本脚本是给 Windows 真机跑的'))

// ── 1. 终端要起的 shell(对应 resolveShell.ts)────────────────────────────────
h('1 · 终端 shell(resolveShell 会按这个顺序挑第一个存在的)')
const shellCandidates = [
  process.env.ProgramFiles ? win32.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe') : null,
  process.env.SystemRoot ? win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null,
  process.env.COMSPEC,
].filter(Boolean)
let shellPicked = null
for (const c of shellCandidates) {
  const hit = existsSync(c)
  if (hit && !shellPicked) shellPicked = c
  say((hit ? ok : no)(c))
}
say(shellPicked ? `  → 会用:${shellPicked}` : hm('三个都不在 —— 会回落到裸 cmd.exe 靠 PATH 解析'))

// ── 2. agent CLI(对应 lookupBin.ts:where + .exe>.cmd>.bat)───────────────────
h('2 · agent CLI(where 的【完整】输出 —— 这决定我们挑哪一个)')
const CLIS = ['claude', 'codex', 'cursor-agent', 'gemini', 'qwen', 'copilot', 'opencode', 'qoder', 'trae', 'kimi', 'pi', 'reasonix', 'agy', 'git', 'node', 'npm']
for (const bin of CLIS) {
  const r = run('where', [bin])
  const lines = r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!r.ok || lines.length === 0 || lines[0].startsWith('INFO:')) { say(no(`${bin}: 未安装`)); continue }
  say(ok(`${bin}:`))
  for (const l of lines) say('       ' + l)
}

// ── 3. CLI 版本(能不能真的起起来 —— .cmd 包装是否透明)───────────────────────
h('3 · CLI 能不能真的起起来(execa 走 cross-spawn,应该能直接起 .cmd)')
for (const bin of ['claude', 'codex', 'git']) {
  const r = run(bin, ['--version'])
  say(r.ok ? ok(`${bin} --version → ${r.out.trim().split(/\r?\n/)[0]}`) : no(`${bin} --version 失败:${r.out.trim().slice(0, 160)}`))
}

// ── 4. 「打开位置」能找到哪些软件(对应 openers/,这是第一期最不确定的一块)──
h('4 · 「打开位置」候选软件(逐条探测 catalog 里的路径模板)')
let templates = []
try {
  templates = openerTemplates(readFileSync(join(ROOT, 'src', 'main', 'openers', 'catalog.ts'), 'utf8'))
  say(`  (从 catalog.ts 提取到 ${templates.length} 条路径模板)`)
} catch (e) { say(hm('读不到 catalog.ts:' + e.message)) }

const expandVars = (t) => {
  let missing = false
  const s = t.replace(/%([^%]+)%/g, (_m, n) => {
    const key = Object.keys(process.env).find(k => k.toLowerCase() === n.toLowerCase())
    if (key === undefined) { missing = true; return '' }
    return process.env[key]
  })
  return missing ? null : s
}
const walk = (base, segs) => {
  if (segs.length === 0) return existsSync(base) ? base : null
  const [head, ...rest] = segs
  if (!head.includes('*')) return walk(base + '\\' + head, rest)
  let entries = []
  try { entries = readdirSync(base) } catch { return null }
  const re = new RegExp('^' + head.replace(/[.+?^${}()|[\]\\]/g, m => '\\' + m).replace(/\*/g, '.*') + '$', 'i')
  for (const name of entries.filter(n => re.test(n)).sort().reverse()) {
    const hit = walk(base + '\\' + name, rest); if (hit) return hit
  }
  return null
}
const found = []
for (const t of templates) {
  const e = expandVars(t)
  if (!e) continue
  const [root, ...segs] = e.split('\\')
  const hit = walk(root, segs)
  if (hit) { found.push(hit); say(ok(`${t}\n       → ${hit}`)) }
}
if (!found.length) say(hm('一个都没探到 —— 要么这些软件都没装,要么路径模板全错了(把下面「实际装在哪」贴给我)'))
say('  实际装在哪(供对照,只列目录名):')
for (const root of [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
  try { say(`       ${root}: ${readdirSync(root).slice(0, 40).join(', ')}`) } catch { /* 读不了就算了 */ }
}

// ── 5. 注册表 App Paths 兜底(对应 winRegistry.ts)────────────────────────────
h('5 · 注册表 App Paths 兜底')
for (const exe of ['Code.exe', 'Cursor.exe', 'idea64.exe', 'sublime_text.exe']) {
  let hit = null
  for (const hive of ['HKCU', 'HKLM']) {
    const r = run('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'])
    if (!r.ok) continue
    const m = /\s(REG_SZ|REG_EXPAND_SZ)\s+(.*)/.exec(r.out)
    if (m) { hit = `${hive} → ${m[2].trim()}`; break }
  }
  say(hit ? ok(`${exe}: ${hit}`) : no(`${exe}: 注册表里没有`))
}

// ── 6. 会话导入的四个根目录(A4 —— 我在 mac 上查不到 Windows 侧确证)─────────
h('6 · 会话导入根目录(★这条就是我需要你验的 A4)')
for (const [name, p] of [
  ['claude', join(homedir(), '.claude', 'projects')],
  ['codex',  join(homedir(), '.codex', 'sessions')],
  ['cursor', join(homedir(), '.cursor', 'projects')],
  ['qoder',  join(homedir(), '.qoder', 'logs', 'sessions')],
]) {
  if (!existsSync(p)) { say(no(`${name}: ${p} 不存在`)); continue }
  let sample = []
  try { sample = readdirSync(p).slice(0, 3) } catch { /* 读不了 */ }
  say(ok(`${name}: ${p}`))
  if (sample.length) say(`       目录名样例(★这个编码方式我也要看):${sample.join(' | ')}`)
}
say('  这四个家目录下还有什么(对照用):')
try { say('       ' + readdirSync(homedir()).filter(n => n.startsWith('.')).join(', ')) } catch { /* 读不了 */ }

// ── 7. claude 凭据文件(A2 —— 已按官方文档实现,验一下真在不在)──────────────
h('7 · claude 登录凭据(额度插件靠这个)')
const credDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const cred = join(credDir, '.credentials.json')
if (existsSync(cred)) {
  let shape = '读不出来'
  try { shape = Object.keys(JSON.parse(readFileSync(cred, 'utf8'))).join(', ') } catch { /* 保持默认 */ }
  say(ok(`${cred} 存在,顶层字段:${shape}   ← 只看字段名,不打印值`))
} else {
  say(no(`${cred} 不存在(没登录过 claude?或者它换地方存了)`))
}

// ── 8. node-pty(终端面板的命根子)────────────────────────────────────────────
h('8 · node-pty 预编译产物(内置终端靠它)')
const pre = join(ROOT, 'node_modules', 'node-pty', 'prebuilds')
if (!existsSync(pre)) say(no(pre + ' 不存在 —— npm install 没跑成?'))
else for (const d of readdirSync(pre)) {
  const files = readdirSync(join(pre, d))
  const mark = d === `win32-${process.arch}` ? '  ← 本机要用的就是这个' : ''
  say(`  ${d}: ${files.filter(f => !f.endsWith('.pdb')).join(', ')}${mark}`)
}

// ── 9. 杀进程树(taskkill,第一期从没真跑过的那一刀)────────────────────────
h('9 · taskkill 在不在(停止 agent 全靠它)')
const tk = run('where', ['taskkill'])
say(tk.ok && tk.out.trim() ? ok(tk.out.trim().split(/\r?\n/)[0]) : no('taskkill 找不到 —— 停止 agent 会杀不干净'))

// ── 10. 长路径(Windows 默认 260 字符上限)────────────────────────────────────
h('10 · 长路径支持(工作区里 node_modules 很容易超 260)')
const lp = run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'])
const on = /0x1/.test(lp.out)
say(on ? ok('LongPathsEnabled = 1(已开)') : hm('LongPathsEnabled 没开 —— 深目录可能报「路径太长」。管理员 PowerShell 里:\n       Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" LongPathsEnabled 1'))
const gitLp = run('git', ['config', '--global', 'core.longpaths'])
say(/true/.test(gitLp.out) ? ok('git core.longpaths = true') : hm('git core.longpaths 没开 —— 建议:git config --global core.longpaths true'))

say('')
say('─'.repeat(72))
say('把以上【全部】贴回给 Claude。不含任何密钥/token —— 第 7 项只打印字段名。')
console.log(out.join('\n'))
