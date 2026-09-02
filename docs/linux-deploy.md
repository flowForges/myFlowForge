# 把 myFlowForge 装在 Linux 上(无界面)

一台 Linux 服务器上跑的是 **daemon** —— 没有窗口、没有宠物、没有壁纸,只有那张方法表。
你在 mac / Windows 的 app 里、或者手机上,连过去操作它。

> 这份文档里的命令和配置都能**直接粘**。要你自己填的地方一律写成 `<...>`,除此之外一个占位符都没有。

---

## 一、先决定走哪条路

| | 用什么 | 什么时候选它 |
|---|---|---|
| **A. Docker** | `Dockerfile.daemon` | 想要一条命令跑起来、不想在服务器上装编译工具链 |
| **B. 裸机 + systemd** | 源码 + `node` | 要让 agent CLI 直接看到宿主机上的文件和登录状态 |

★**agent CLI 的登录在容器里要单独做一遍**(见第五节)。如果你已经在这台服务器上
`claude` / `codex` 登录过了,选 **B** 能直接复用那份凭据 —— 这通常是决定性的一条。

---

## 二、A:Docker

在**你自己的电脑**上(有源码那台)先打出产物,再把镜像构建出来:

```bash
npm run build
docker build -f Dockerfile.daemon -t mff-daemon .
docker run -d --name mff --restart unless-stopped -p 6767:6767 \
  -v mff-data:/root/.myFlowForge \
  mff-daemon
```

★`-v mff-data:/root/.myFlowForge` **不能省**:这台机器的**长期身份**(`identity.json`)和访问令牌都在那儿。
不挂卷的话,容器一重建身份就变了 —— 所有配过对的设备**全部**要重新扫码。

拿配对信息:

```bash
docker exec -t mff node /app/out/main/daemon.js pair --listen 0.0.0.0:6767 --address <服务器公网地址>:6767
```

★`-t` 是画二维码用的(没有 TTY 时它会自动改成只印配对码,那行照样能粘)。
★`--address` **必须给**:云服务器网卡上挂的多半是内网地址(10.x / 172.x),自动探测在那儿一定是错的。

---

## 三、B:裸机 + systemd

### 1. 装

★**产物在你自己的电脑上打,不在服务器上打**。`npm run build` 要 `@vitejs/plugin-react` 和
 electron 那一串开发依赖(几百 MB,而且 electron 的二进制在国内经常拉不下来),
 而服务器上一行 electron 都不该有。镜像那条路走的也是这个顺序。

在**你自己的电脑**上:

```bash
npm run build
rsync -a out/main package.json package-lock.json scripts/postinstall.mjs \
  <你的服务器>:/opt/myflowforge/
```

在**服务器**上:

```bash
sudo apt-get update && sudo apt-get install -y python3 make g++ git ca-certificates
# node 22(nvm / nodesource / 发行版包都行)
sudo mkdir -p /opt/myflowforge && sudo chown "$USER" /opt/myflowforge
cd /opt/myflowforge && npm ci --omit=dev
```

★`python3 make g++` 是 **node-pty** 要现编用的(Linux 上它没有覆盖所有 ABI 的预编译包)。
 装完确认一句就够了:

```bash
node -e "const p=require('node-pty').spawn('/bin/sh',['-c','echo PTY-OK'],{cols:80,rows:24});p.onData(d=>process.stdout.write(d))"
```

★`git` 是 daemon 自己要用的 —— 工作区、变更、分支全靠它。

### 2. systemd unit

把下面这一整份存成 `/etc/systemd/system/myflowforge.service`。**只有 `<你的用户名>` 一处要改**:

```ini
[Unit]
Description=myFlowForge daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<你的用户名>
WorkingDirectory=/opt/myflowforge
# 只绑回环 = 从别的机器连要走 SSH 隧道(最省心也最安全的默认)。
# 要让手机直接连,把下面这行换成 0.0.0.0:6767,并放开防火墙 —— 那时令牌是强制的。
ExecStart=/usr/bin/env node /opt/myflowforge/out/main/daemon.js --listen 127.0.0.1:6767
Restart=always
RestartSec=3
# daemon 的身份、令牌、工作区登记都写在 $HOME/.myFlowForge/ 下。
# ★不显式给 HOME 的话,systemd 起的进程可能落到 / ,身份文件会写到一个你找不到的地方。
Environment=HOME=/home/<你的用户名>
# agent CLI 大多装在这两个地方,systemd 的默认 PATH 里没有它们。
Environment=PATH=/home/<你的用户名>/.local/bin:/home/<你的用户名>/.nvm/versions/node/current/bin:/usr/local/bin:/usr/bin:/bin
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now myflowforge
journalctl -u myflowforge -f          # 看它有没有起来
```

### 3. 拿配对信息

```bash
cd /opt/myflowforge && node out/main/daemon.js pair
```

绑回环时它印的是 **SSH 隧道**那套(在 app 里选「通过 SSH 连接」,隧道由 app 自己拉起来)。
要让**手机**连,手机没有 SSH 那一档,得改成对外监听:

```bash
# 改 unit 里的 ExecStart 成 --listen 0.0.0.0:6767,然后
sudo systemctl restart myflowforge
node out/main/daemon.js pair --listen 0.0.0.0:6767 --address <服务器公网地址>:6767
```

---

## 四、NAT 后面的机器(家里的小主机 / 没有公网 IP)

daemon 主动拨到一个**中转**,客户端也拨到同一个房间 —— 两端都是出站连接,
不需要端口转发、不需要公网 IP。

中转自己跑一个(它没有状态、没有密钥、看不到任何内容):

```bash
cd relay && docker build -t mff-relay . && docker run -d --name relay --restart unless-stopped -p 8787:8787 mff-relay
```

daemon 挂上去(`ExecStart` 里加 `--relay`):

```
ExecStart=/usr/bin/env node /opt/myflowforge/out/main/daemon.js --listen 127.0.0.1:6767 --relay wss://<你的中转域名>/
```

出码时把中转地址一起带上:

```bash
node out/main/daemon.js pair --relay wss://<你的中转域名>/
```

★中转那条路**一定要令牌**,哪怕 daemon 只绑了回环 —— 房间号是从公钥算的,而公钥印在配对码里,
谁拿到码谁就能拨进那个房间。`pair` 印出来的码里已经带上了。
★内容对中转是**不可读**的:两端在中转里面又套了一层端到端加密,中转只看得到密文和房间号。

---

## 五、agent CLI 怎么在无头机器上登录

这是整个部署里最容易卡住的一节 —— 它和 myFlowForge 无关,是各家 CLI 自己的事。

| CLI | 无头登录 | 凭据在哪 | 从别的机器拷得过来吗 |
|---|---|---|---|
| **claude** | `claude setup-token`,或设 `ANTHROPIC_API_KEY` | **不在 `~/.claude/` 里**(mac 上是钥匙串) | ❌ 拷目录没用 |
| **codex** | `printenv OPENAI_API_KEY \| codex login --with-api-key` | `~/.codex/auth.json`(明文) | ✅ |
| **copilot** | OAuth device flow,或 `GH_TOKEN` / `GITHUB_TOKEN` | 系统凭据库,回退 `~/.copilot/` | ✅ 无头最省心 |
| 其余内置 provider | 各家不同 | — | 自行验证 |

通用兜底 —— **把 OAuth 的回调端口转发到你本地浏览器**:

```bash
ssh -L 54545:localhost:54545 <你的服务器>     # 端口号看 CLI 打印的是哪个
# 然后在服务器上跑登录命令,把它打印的 http://localhost:54545/... 粘到【本地】浏览器
```

app 里会**如实显示**某个 provider 在这台主机上有没有登录(凭据可用性检测),
不会让你建了会话、发了消息、等半天才发现没登录。

---

## 六、安全

- **非回环监听一律强制令牌**,daemon 自己拦着,不给就不启动。令牌等于整台机器的控制权
  (能起 agent、替你答权限门、开终端)—— 别贴进聊天记录或截图。
- **换令牌** = 踢掉所有已配对设备:删掉 `~/.myFlowForge/daemon.json` 里的 `token` 再重启,然后重新 `pair`。
- **身份公钥别换**。`identity.json` 是整条链路唯一的信任锚点,换了等于所有设备重新扫码。
  `daemon status` 印的就是它,两边对不上时第一件事就是对这个。
- 直接开在公网上时,建议只放行你自己的出口 IP:
  `sudo ufw allow from <你的出口IP> to any port 6767 proto tcp`

---

## 七、验一遍

在**有源码的机器**上(mac / 你自己的电脑):

```bash
npm run build && npm run check:daemon
```

它把打包产物当成真进程跑起来,走完整条路:起 daemon → `pair` → 解开配对码 →
拿里面那把公钥连上去(端到端加密)→ invoke 一个真方法。

服务器那一侧单独探一次:

```bash
node scripts/daemon-probe.mjs ws://<服务器地址>:6767 <令牌>
```

---

## 八、已知的边界

- **终端(`term:*`)在 daemon 上不通**。它是 Electron 那一侧直接注册的,没进方法表,
  所以远程连过去看不到终端。不是坏了,是没接。
- **没有 GUI**。宠物、壁纸、工作区面板都在客户端那一侧 —— 那是设计如此,不是 Linux 上砍了功能。
- 本文档 2026-09-02 在 **Debian 12 / node 22 / x86_64**(Docker)上实跑过:daemon 起得来、
  `pair` 出的码解得开、从另一台机器直连和经中转两条路都握上手并 invoke 成功、node-pty 能编能用。
  各家 agent CLI 的登录没有在这上面验 —— 那一节照抄的是各 CLI 自己的帮助。
