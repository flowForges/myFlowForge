# myFlowForge 中转

把 NAT 后面的电脑和你的手机接起来的那个东西。**两百多行,二十分钟能读完 —— 请在部署前读一遍。**

## 它是什么

一个哑管道。一台 daemon（host）和若干客户端靠**同一个房间号**在这里碰头，之后它做的
全部事情是：把 A 说的话原样念给 B 听。

房间号 = `base64(daemon 的长期公钥)`。两端各自算得出，**不需要在这里注册任何东西** ——
这就是"部署完就能用"的全部依据。

## 它做不到什么

- **读不到内容。** 两端之间是端到端加密的（`src/shared/remote/e2e.ts`，主仓）。
  流过这里的每一个字节都是密文，中转没有密钥，永远不会有。
- **冒充不了 daemon。** 客户端认的是配对时从电脑屏幕上搬过来的那把公钥；握手要用长期私钥
  签名。占了房间也签不出来。
- **改不了一个字节而不被发现。** 密文带认证标签，改一位就解不开。

它唯一能做的坏事是**丢包**。那是拒绝服务，不是泄密。这就是"中转不可信"的确切含义 ——
也是为什么你可以放心把它部署在别人的机器上。

## 它故意不做什么

- 不落盘、不记内容、不做统计。`/healthz` 只报数字，**不含房间号**（那是可关联的信息）。
- 不做鉴权。谁都能连，连上也拿不到任何东西（见上）。加鉴权只会给自建多一道坎，
  换不来任何安全性。
- 不依赖主仓的任何代码。它要能被单独 clone 出去部署。

## 跑起来

### Docker（推荐给有 VPS 的人）

```bash
docker build -t myflowforge-relay .
docker run -d --restart=always -p 8787:8787 --name relay myflowforge-relay
```

然后在 app 里填 `ws://你的服务器:8787`。**生产上请套一层 TLS**（Caddy / nginx 反代到
`wss://`）—— 不是为了内容（内容本来就是密文），而是为了别让沿途的人知道你在跟谁通信。

### 直接跑

```bash
npm install && npm run build && npm start
```

环境变量：`PORT`（默认 8787）、`HOST`（默认 0.0.0.0）。没有别的。

### Cloudflare Workers（不想管服务器就选这个）

```bash
npm install
npx wrangler deploy
```

然后在 app 里填 `wss://myflowforge-relay.<你的账号>.workers.dev/`。

**为什么推荐它**：中转是全流量转发，而这里的带宽是 Cloudflare 出的；你那台 VPS 应该留着跑 daemon。

★**一个 Worker 只有一个 Durable Object 实例**，所有房间都在它里面（和 Node 版完全一样，
撮合核心本来就是多房间的）。按房间分实例需要在 WebSocket 升级**之前**就知道房间号，
也就只能放进 URL —— 而房间号是 daemon 的公钥，**放进 URL 等于写进 Cloudflare 的日志**。
这份东西连 `/healthz` 都不报房间号，不会为了扩展性把它交出去。
代价是单实例的吞吐上限：自建（自己那几台设备）远远够用，要做公共服务请另想办法。

★★**Worker 那条路没有自动化测试**：跑它要 miniflare / wrangler 的运行时。
能测的部分（撮合、hibernation 醒来后的重建、cid 分配）都在 `core.ts` 里，那边是全覆盖的；
`worker.ts` 只剩「把 Cloudflare 的 API 接上去」这一层，**必须真部署一次才算验过**。

## ⚠️ 别把自己的小带宽 VPS 当公共中转

中转是**全流量转发**：两端之间的每一个字节都从这里过一遍。你的带宽会被所有用它的人一起
花掉。放 Cloudflare 上带宽是 Cloudflare 出的；VPS 应该留着跑 daemon。

## 有公网 IP 的话，你根本不需要它

daemon 直接监听端口，手机和笔记本**直连**就行 —— 走的是同一套端到端加密，
安全性完全等同，少一跳。Tailscale / ZeroTier / frp 内网穿透同理。
中转是给"没有任何一条上述路子"的人准备的，不是默认答案。

## 代码在哪

| 文件 | 是什么 |
|---|---|
| `src/core.ts` | 撮合逻辑。**两个适配器共用这一份。** 没有一行密码学代码，也永远不该有 |
| `src/node.ts` | Node / Docker 适配器（`ws`） |
| `src/worker.ts` | Cloudflare Workers + Durable Object 适配器。★开了 hibernation，所以醒来时要靠 `core.restore()` 把房间重建回去 —— 不重建的症状是「挂了一晚上之后再也收不到东西，而两边都显示连着」 |
| `wrangler.toml` | Worker 部署配置。★必须用 `new_sqlite_classes` 迁移，否则 hibernation 走不通 |
| `src/main.ts` | 可执行入口 |
| `src/core.test.ts` | 撮合逻辑的单测 |
| `src/e2e.integration.test.ts` | **真 WebSocket + 真加密 + 真中转**，证明中转全程只见到密文 |
