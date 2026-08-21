# myFlowForge · 虚拟机开发环境一键装（Windows 11）
#
# ⚠️ 这个脚本【会装东西】,和只读的 win-doctor.ps1 不一样。只在【虚拟机】里跑,别在你真机上跑。
#
# 跑法(普通 PowerShell,不用管理员):
#   powershell -ExecutionPolicy Bypass -File .\vm-bootstrap.ps1
#
# 装完【关掉这个 PowerShell 窗口重开一个】—— winget 装的东西要新开的会话才认得到 PATH。

$ErrorActionPreference = 'Stop'

function Step($n, $t) { "" ; "=== $n · $t " + ("=" * [Math]::Max(0, 50 - $t.Length)) }
function Have($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

Step 0 "先看看 winget 在不在"
if (-not (Have 'winget')) {
  "  winget 找不到。Win11 自带,Win10 需要从 Microsoft Store 装「应用安装程序」。"
  "  装好后重开 PowerShell 再跑本脚本。"
  exit 1
}
"  winget " + (winget --version)

Step 1 "Node.js LTS"
if (Have 'node') { "  已有 node " + (node -v) + ",跳过" }
else { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements }

Step 2 "Git for Windows"
# 装它有两个理由:①克隆仓库 ②Claude Code 有 Git Bash 才能用 Bash 工具,没有就退回 PowerShell 工具
if (Have 'git') { "  已有 " + (git --version) + ",跳过" }
else { winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements }

Step 3 "Claude Code"
# 官方 winget 包。装出来是 %USERPROFILE%\.local\bin\claude.exe(真 exe,不是 .cmd 包装)
if (Have 'claude') { "  已有 claude,跳过" }
else { winget install -e --id Anthropic.ClaudeCode --accept-source-agreements --accept-package-agreements }

Step 4 "VS Code(第 12 步「打开位置」要用它验)"
if (Have 'code') { "  已有 code,跳过" }
else { winget install -e --id Microsoft.VisualStudioCode --accept-source-agreements --accept-package-agreements }

Step 5 "刷新本会话的 PATH"
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path','User')
"  已刷新(但保险起见,装完还是重开一个 PowerShell)"

Step 6 "Codex CLI(要 npm,所以放在 Node 之后)"
if (Have 'codex') { "  已有 codex,跳过" }
elseif (Have 'npm') { npm install -g "@openai/codex" }
else { "  !! npm 还不在 PATH 里 —— 重开 PowerShell 后手动跑:npm install -g @openai/codex" }

Step 7 "建议打开的两个开关(可选,但工作区目录深了会用上)"
if (Have 'git') { git config --global core.longpaths true; "  git core.longpaths = true 已设" }
"  Windows 长路径支持要管理员权限,想开的话在【管理员】PowerShell 里跑:"
'    Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" LongPathsEnabled 1'

Step 8 "清点"
foreach ($c in @('node','npm','git','claude','codex','code')) {
  if (Have $c) { "  [OK]  $c" } else { "  [--]  $c  <- 重开 PowerShell 再看一次" }
}

""
"=" * 60
"下一步:"
"  1) 关掉这个窗口,重开一个 PowerShell"
"  2) claude          <- 登录一次(会开浏览器)"
"  3) codex login     <- 登录一次"
"  4) 把 myFlowForge 代码弄进来,然后:"
"       npm install"
"       node scripts\\win-doctor.ps1 > doctor.txt      <- 先跑这个,贴给 Claude"
"       npm run dist:win"
