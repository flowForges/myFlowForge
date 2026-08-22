# myFlowForge · 虚拟机开发环境一键装（Windows 11）
#
# ⚠️ 这个脚本【会装东西】,和只读的 win-doctor.ps1 不一样。只在【虚拟机】里跑,别在你真机上跑。
#
# 跑法(普通 PowerShell,不用管理员):
#   powershell -ExecutionPolicy Bypass -File .\vm-bootstrap.ps1 -Proxy http://10.211.55.2:7897 -SkipClaude
#
#   -Proxy       给虚拟机配代理(环境变量 + npm + git 三处一起配)。不传就不动代理设置。
#   -SkipClaude  不装 Claude Code(只用 codex 测的话加上它)
#
# 装完【关掉这个 PowerShell 窗口重开一个】—— winget 装的东西和环境变量都要新会话才认得到。

param(
  [string]$Proxy = '',
  [switch]$SkipClaude
)

$ErrorActionPreference = 'Stop'

function Step($n, $t) { "" ; "=== $n · $t " + ("=" * [Math]::Max(0, 50 - $t.Length)) }
function Have($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

# ★ 每条 install 都写死 --source winget:走代理时 msstore 源会因为证书固定而报
#   `0x8a15005e The server certificate did not match any of the expected values`,
#   winget 一旦有源查询失败就不敢自己选源,每个包都停在「请用 --source 指定」什么也装不上。
$SRC = @('--source','winget','--accept-source-agreements','--accept-package-agreements')

Step 0 "先看看 winget 在不在"
if (-not (Have 'winget')) {
  "  winget 找不到。Win11 自带,Win10 需要从 Microsoft Store 装「应用安装程序」。"
  "  装好后重开 PowerShell 再跑本脚本。"
  exit 1
}
"  winget " + (winget --version)

if ($Proxy) {
  Step 0.5 "配代理:$Proxy"
  # 三处都要配,少一处就有东西走直连然后卡死:
  #   环境变量  → node / npm / codex / claude / 绝大多数 CLI
  #   npm 配置  → npm 自己有独立的代理设置,不读环境变量的那部分场景
  #   git 配置  → git 走 libcurl,同样自成一套
  # 本机回环不能走代理,否则 app 自己的 MCP 命名管道之类会被绕进去。
  $noProxy = 'localhost,127.0.0.1,::1'
  [Environment]::SetEnvironmentVariable('HTTP_PROXY',  $Proxy,   'User')
  [Environment]::SetEnvironmentVariable('HTTPS_PROXY', $Proxy,   'User')
  [Environment]::SetEnvironmentVariable('NO_PROXY',    $noProxy, 'User')
  $env:HTTP_PROXY = $Proxy; $env:HTTPS_PROXY = $Proxy; $env:NO_PROXY = $noProxy
  "  环境变量已设(User 级,永久)"
  "  (系统代理请另外用注册表或设置界面配 —— winget/Edge 走 WinINET,不读环境变量)"
}

Step 1 "Node.js LTS"
if (Have 'node') { "  已有 node " + (node -v) + ",跳过" }
else { winget install -e --id OpenJS.NodeJS.LTS @SRC }

Step 2 "Git for Windows"
# 装它有两个理由:①克隆仓库 ②Claude Code 有 Git Bash 才能用 Bash 工具,没有就退回 PowerShell 工具
if (Have 'git') { "  已有 " + (git --version) + ",跳过" }
else { winget install -e --id Git.Git @SRC }

Step 3 "Claude Code"
# 官方 winget 包。装出来是 %USERPROFILE%\.local\bin\claude.exe(真 exe,不是 .cmd 包装)
if ($SkipClaude) { "  -SkipClaude,跳过" }
elseif (Have 'claude') { "  已有 claude,跳过" }
else { winget install -e --id Anthropic.ClaudeCode @SRC }

Step 4 "VS Code(第 12 步「打开位置」要用它验)"
if (Have 'code') { "  已有 code,跳过" }
else { winget install -e --id Microsoft.VisualStudioCode @SRC }

Step 5 "刷新本会话的 PATH"
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path','User')
"  已刷新(但保险起见,装完还是重开一个 PowerShell)"

Step 6 "给 npm 和 git 配代理(要等 Node/Git 装完才能配)"
if ($Proxy) {
  if (Have 'npm') { npm config set proxy $Proxy; npm config set https-proxy $Proxy; "  npm 已配" }
  else { "  !! npm 还不在 PATH 里 —— 重开 PowerShell 后手动跑:npm config set proxy $Proxy; npm config set https-proxy $Proxy" }
  if (Have 'git') { git config --global http.proxy $Proxy; git config --global https.proxy $Proxy; "  git 已配" }
} else { "  没传 -Proxy,跳过" }

Step 7 "Codex CLI"
if (Have 'codex') { "  已有 codex,跳过" }
elseif (Have 'npm') { npm install -g "@openai/codex" }
else { "  !! npm 还不在 PATH 里 —— 重开 PowerShell 后手动跑:npm install -g @openai/codex" }

Step 8 "长路径(node_modules 嵌套很深,不开会在安装中途报「路径太长」)"
if (Have 'git') { git config --global core.longpaths true; "  git core.longpaths = true 已设" }
$lp = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -ErrorAction SilentlyContinue).LongPathsEnabled
if ($lp -eq 1) { "  Windows LongPathsEnabled 已开" }
else {
  "  ⚠️ Windows 长路径【没开】。要【管理员】PowerShell 跑这句,然后【重启 Windows】:"
  '     Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" LongPathsEnabled 1'
}

Step 9 "清点"
foreach ($c in @('node','npm','git','codex','code','claude')) {
  if (Have $c) { "  [OK]  $c" } else { "  [--]  $c  <- 重开 PowerShell 再看一次" }
}
if ($Proxy) {
  "  代理连通性自测(打不通就是 Mac 那边没开「允许局域网连接」):"
  try {
    $r = Invoke-WebRequest -Uri 'https://registry.npmjs.org/-/ping' -Proxy $Proxy -TimeoutSec 10 -UseBasicParsing
    "  [OK]  通过代理能连上 npm registry(HTTP $($r.StatusCode))"
  } catch { "  [--]  代理连不通:$($_.Exception.Message)" }
}

""
"=" * 60
"下一步:"
"  1) 关掉这个窗口,重开一个 PowerShell"
"  2) codex login    <- 登录一次"
"  3) cd C:\forge"
"     git clone myflowforge-win.bundle myFlowForge"
"     cd myFlowForge"
"     npm install"
"     node scripts\\win-doctor.mjs > doctor.txt      <- 贴给 Claude"
"     npm run dist:win"
