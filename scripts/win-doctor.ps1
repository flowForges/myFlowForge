# myFlowForge · Windows 体检(零安装版)
#
# 只用 Windows 自带的 PowerShell,不需要 Node、不需要 git、不需要克隆仓库。
# 纯只读:不装任何东西、不改注册表、不写除报告外的任何文件。
#
# 跑法(在 PowerShell 里,不需要管理员):
#   powershell -ExecutionPolicy Bypass -File .\win-doctor.ps1 | Out-File -FilePath doctor.txt -Encoding utf8
#
# 然后把 doctor.txt 整个贴回给 Claude。第 7 节只打印字段名,不打印任何凭据内容。
#
# ⚠️ 这个文件里的路径模板是从 src/main/openers/catalog.ts 生成的,由 winDoctorTemplates.test.ts 看着,
#    改了 catalog 而忘了重新生成会导致测试失败。生成命令见该测试文件顶部。

$ErrorActionPreference = 'SilentlyContinue'
function Section($t) { "" ; "-- $t " + ("-" * [Math]::Max(0, 64 - $t.Length)) }
function Yes($t) { "  [OK]   $t" }
function No($t)  { "  [--]   $t" }
function Hmm($t) { "  [!]    $t" }

Section "0 环境"
"  OS        : " + (Get-CimInstance Win32_OperatingSystem).Caption + " build " + [System.Environment]::OSVersion.Version.Build
"  架构      : $env:PROCESSOR_ARCHITECTURE"
"  PowerShell: $($PSVersionTable.PSVersion)"
"  用户目录  : $env:USERPROFILE"
foreach ($k in @('LOCALAPPDATA','APPDATA','ProgramFiles','ProgramFiles(x86)','SystemRoot','COMSPEC','PATHEXT','CLAUDE_CONFIG_DIR','TEMP')) {
  $v = [Environment]::GetEnvironmentVariable($k)
  if ($v) { "  %$k% = $v" } else { "  %$k% = (未设置)" }
}

Section "1 终端 shell(resolveShell 会挑第一个存在的)"
$shellCands = @()
if ($env:ProgramFiles) { $shellCands += (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe') }
if ($env:SystemRoot)   { $shellCands += (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') }
if ($env:COMSPEC)      { $shellCands += $env:COMSPEC }
$picked = $null
foreach ($c in $shellCands) {
  if (Test-Path -LiteralPath $c) { Yes $c; if (-not $picked) { $picked = $c } } else { No $c }
}
if ($picked) { "  -> 会用:$picked" } else { Hmm "三个都不在 —— 会回落到裸 cmd.exe 靠 PATH 解析" }

Section "2 agent CLI(where.exe 的【完整】输出 —— 这决定我们挑哪一个)"
$clis = @('claude','codex','cursor-agent','gemini','qwen','copilot','opencode','qoder','trae','kimi','pi','reasonix','agy','git','node','npm')
foreach ($bin in $clis) {
  $hits = & where.exe $bin 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $hits) { No "$bin : 未安装"; continue }
  Yes "$bin :"
  foreach ($h in $hits) { "         $h" }
}

Section "3 CLI 能不能真的起起来"
foreach ($bin in @('claude','codex','git','node')) {
  $v = & $bin --version 2>$null | Select-Object -First 1
  if ($LASTEXITCODE -eq 0 -and $v) { Yes "$bin --version -> $v" } else { No "$bin --version 起不来" }
}

Section "4 「打开位置」候选软件(逐条探测 catalog 的路径模板)"
$templates = @(
  '%ProgramFiles%\JetBrains\*\bin\goland64.exe',
  '%ProgramFiles%\JetBrains\*\bin\idea64.exe',
  '%ProgramFiles%\JetBrains\*\bin\pycharm64.exe',
  '%ProgramFiles%\JetBrains\*\bin\webstorm64.exe',
  '%ProgramFiles%\JetBrains\*\bin\phpstorm64.exe',
  '%ProgramFiles%\JetBrains\*\bin\rustrover64.exe',
  '%ProgramFiles%\JetBrains\*\bin\clion64.exe',
  '%ProgramFiles%\JetBrains\*\bin\rider64.exe',
  '%ProgramFiles%\JetBrains\*\bin\datagrip64.exe',
  '%ProgramFiles(x86)%\JetBrains\*\bin\goland64.exe',
  '%ProgramFiles(x86)%\JetBrains\*\bin\idea64.exe',
  '%ProgramFiles(x86)%\JetBrains\*\bin\pycharm64.exe',
  '%ProgramFiles(x86)%\JetBrains\*\bin\webstorm64.exe',
  '%ProgramFiles(x86)%\JetBrains\*\bin\phpstorm64.exe',
  '%ProgramFiles(x86)%\JetBrains\*\bin\rustrover64.exe',
  '%ProgramFiles(x86)%\JetBrains\*\bin\clion64.exe',
  '%ProgramFiles(x86)%\JetBrains\*\bin\rider64.exe',
  '%ProgramFiles(x86)%\JetBrains\*\bin\datagrip64.exe',
  '%LOCALAPPDATA%\Programs\*\bin\goland64.exe',
  '%LOCALAPPDATA%\Programs\*\bin\idea64.exe',
  '%LOCALAPPDATA%\Programs\*\bin\pycharm64.exe',
  '%LOCALAPPDATA%\Programs\*\bin\webstorm64.exe',
  '%LOCALAPPDATA%\Programs\*\bin\phpstorm64.exe',
  '%LOCALAPPDATA%\Programs\*\bin\rustrover64.exe',
  '%LOCALAPPDATA%\Programs\*\bin\clion64.exe',
  '%LOCALAPPDATA%\Programs\*\bin\rider64.exe',
  '%LOCALAPPDATA%\Programs\*\bin\datagrip64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\bin\goland64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\bin\idea64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\bin\pycharm64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\bin\webstorm64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\bin\phpstorm64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\bin\rustrover64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\bin\clion64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\bin\rider64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\bin\datagrip64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\*\bin\goland64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\*\bin\idea64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\*\bin\pycharm64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\*\bin\webstorm64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\*\bin\phpstorm64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\*\bin\rustrover64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\*\bin\clion64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\*\bin\rider64.exe',
  '%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\*\bin\datagrip64.exe',
  '%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe',
  '%LOCALAPPDATA%\Programs\cursor\Cursor.exe',
  '%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe',
  '%LOCALAPPDATA%\Programs\Windsurf\Windsurf.exe',
  '%ProgramFiles%\Microsoft VS Code\Code.exe',
  '%ProgramFiles%\cursor\Cursor.exe',
  '%ProgramFiles%\Antigravity\Antigravity.exe',
  '%ProgramFiles%\Windsurf\Windsurf.exe',
  '%ProgramFiles(x86)%\Microsoft VS Code\Code.exe',
  '%ProgramFiles(x86)%\cursor\Cursor.exe',
  '%ProgramFiles(x86)%\Antigravity\Antigravity.exe',
  '%ProgramFiles(x86)%\Windsurf\Windsurf.exe',
  '%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe',
  '%LOCALAPPDATA%\Programs\Cursor\Cursor.exe',
  '%LOCALAPPDATA%\Programs\Zed\Zed.exe',
  '%LOCALAPPDATA%\Zed\Zed.exe',
  '%ProgramFiles%\Zed\Zed.exe',
  '%ProgramFiles%\Sublime Text\sublime_text.exe',
  '%ProgramFiles%\Sublime Text 3\sublime_text.exe',
  '%ProgramFiles(x86)%\Sublime Text 3\sublime_text.exe',
  '%SystemRoot%\explorer.exe',
  '%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe'
)
"  (共 " + $templates.Count + " 条模板)"
# 把 %VAR% 展开成真实路径。任何一个变量没定义就整条作废 —— 替换成空串会留下 `\Windows\explorer.exe`
# 这种盘符相对路径,Windows 会拿当前盘去解析,等于探测了另一个文件。
# (故意不用 [regex]::Replace 的 MatchEvaluator:在 scriptblock 里改外层变量的作用域规则太容易写错。)
function Expand-Tmpl($t) {
  $out = $t
  foreach ($m in [regex]::Matches($t, '%([^%]+)%')) {
    $n = $m.Groups[1].Value
    $v = [Environment]::GetEnvironmentVariable($n)
    if ($null -eq $v -or $v -eq '') { return $null }
    $out = $out.Replace('%' + $n + '%', $v)
  }
  return $out
}
function Resolve-Walk($base, $segs) {
  if ($segs.Count -eq 0) { if (Test-Path -LiteralPath $base) { return $base } else { return $null } }
  $head = $segs[0]
  $rest = @()
  if ($segs.Count -gt 1) { $rest = $segs[1..($segs.Count - 1)] }
  if ($head -notmatch '\*') { return Resolve-Walk (Join-Path $base $head) $rest }
  $kids = Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue
  if (-not $kids) { return $null }
  foreach ($k in ($kids | Where-Object { $_.Name -like $head } | Sort-Object Name -Descending)) {
    $hit = Resolve-Walk $k.FullName $rest
    if ($hit) { return $hit }
  }
  return $null
}
$foundAny = $false
foreach ($t in $templates) {
  $e = Expand-Tmpl $t
  if (-not $e) { continue }
  $parts = $e -split '\\'
  $root = $parts[0]
  $segs = @()
  if ($parts.Count -gt 1) { $segs = $parts[1..($parts.Count - 1)] }
  $hit = Resolve-Walk $root $segs
  if ($hit) { $foundAny = $true; Yes $t; "         -> $hit" }
}
if (-not $foundAny) { Hmm "一个都没探到 —— 看下面「实际装在哪」的对照" }
"  实际装在哪(对照用,只列目录名):"
foreach ($r in @((Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if (-not $r -or -not (Test-Path -LiteralPath $r)) { continue }
  $names = (Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue | Select-Object -First 40 -ExpandProperty Name) -join ', '
  "         ${r}: $names"
}

Section "5 注册表 App Paths 兜底(只读)"
foreach ($exe in @('Code.exe','Cursor.exe','idea64.exe','sublime_text.exe','Windsurf.exe')) {
  $hit = $null
  foreach ($hive in @('HKCU:','HKLM:')) {
    $p = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
    $v = (Get-ItemProperty -LiteralPath $p -ErrorAction SilentlyContinue).'(default)'
    if ($v) { $hit = "$hive -> $v"; break }
  }
  if ($hit) { Yes "${exe}: $hit" } else { No "${exe}: 注册表里没有" }
}

Section "6 会话导入根目录(★这条虚拟机给不了,只有你真机能答)"
$roots = @{
  'claude' = (Join-Path $env:USERPROFILE '.claude\projects')
  'codex'  = (Join-Path $env:USERPROFILE '.codex\sessions')
  'cursor' = (Join-Path $env:USERPROFILE '.cursor\projects')
  'qoder'  = (Join-Path $env:USERPROFILE '.qoder\logs\sessions')
}
foreach ($k in $roots.Keys) {
  $p = $roots[$k]
  if (-not (Test-Path -LiteralPath $p)) { No "${k}: $p 不存在"; continue }
  Yes "${k}: $p"
  $sample = (Get-ChildItem -LiteralPath $p -ErrorAction SilentlyContinue | Select-Object -First 3 -ExpandProperty Name) -join ' | '
  if ($sample) { "         目录名样例(★编码方式我也要看):$sample" }
}
"  家目录下的点目录(对照用):"
"         " + ((Get-ChildItem -LiteralPath $env:USERPROFILE -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '.*' } | Select-Object -ExpandProperty Name) -join ', ')

Section "7 claude 登录凭据(额度插件靠这个;只看字段名)"
$credDir = $env:CLAUDE_CONFIG_DIR
if (-not $credDir) { $credDir = Join-Path $env:USERPROFILE '.claude' }
$cred = Join-Path $credDir '.credentials.json'
if (Test-Path -LiteralPath $cred) {
  $keys = '(读不出来)'
  try { $keys = ((Get-Content -LiteralPath $cred -Raw | ConvertFrom-Json).PSObject.Properties.Name) -join ', ' } catch { }
  Yes "$cred 存在,顶层字段:$keys"
} else {
  No "$cred 不存在(没登录过 claude?还是换地方存了?)"
}

Section "8 taskkill(停止 agent 全靠它)"
$tk = & where.exe taskkill 2>$null | Select-Object -First 1
if ($tk) { Yes $tk } else { No "taskkill 找不到 —— 停止 agent 会杀不干净" }

Section "9 长路径支持(工作区里 node_modules 很容易超 260)"
$lp = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -ErrorAction SilentlyContinue).LongPathsEnabled
if ($lp -eq 1) { Yes "LongPathsEnabled = 1(已开)" } else { Hmm "LongPathsEnabled 没开 —— 深目录可能报「路径太长」" }
$glp = & git config --global core.longpaths 2>$null
if ($glp -eq 'true') { Yes "git core.longpaths = true" } else { Hmm "git core.longpaths 没开(建议 git config --global core.longpaths true)" }

Section "10 Windows 版本能不能出 mica"
$build = [System.Environment]::OSVersion.Version.Build
if ($build -ge 22621) { Yes "build $build >= 22621(Win11 22H2+),mica/acrylic 应该有效果" }
elseif ($build -ge 22000) { Hmm "build $build 是 Win11 但低于 22H2 —— 磨砂会静默画成不透明,不是 bug" }
else { Hmm "build $build 是 Win10 —— 没有 mica,磨砂那档验不了,不是 bug" }

""
"-" * 70
"把以上全部贴回给 Claude。全程只读,没有任何凭据内容(第 7 节只打印字段名)。"
