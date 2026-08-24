# myFlowForge · 手机端

第四期。Expo + expo-router + TypeScript,一套代码跑 iOS / Android。

**它不在本地跑代理。** 它是你电脑上那台 Forge 的遥控器 —— 通过第二期做好的 daemon 连过去。

## 这东西存在的唯一理由

代理跑到一半弹了个确认,然后卡在那儿等你,而你不在电脑前。

所以**门是全屏视觉优先级最高的元素**,并且是屏幕上**唯一的实底彩色块**。
其余一切保持中性;靛蓝只给「你」的气泡和发送键。别在别处再加一种彩色 —— 多一种,门就不再是唯一的那个。

## 跑起来

```bash
cd mobile
npm install
npm run web        # react-native-web,浏览器里就能点
npm run ios        # 需要 Xcode 装了 iOS 模拟器运行时
npm run android    # 需要 Java + Android SDK
npm run typecheck
```

要有东西可看,电脑那头得先开门。**优先用 app 自己那扇**:

> 桌面端 → 设置 → 主机 → **手机端** → 打开开关。地址和令牌就显示在那儿,可以直接复制。

★为什么优先用它:网关端在 **app 进程里**,手机和电脑面对的是**同一份核心** ——
同一张权限门表、同一份会话状态。手机上答掉的门,电脑上那张卡当场消失;电脑上发的消息,手机立刻看得到。

另起一个 daemon 也能让手机连上,但那是**第二个独立核心**:两份会话缓存、两张门表,
读写同一批文件却互不通气,两边看到的东西会对不上。它现在的用途只剩「这台机器上没装 app」
(Linux 服务器):

```bash
npm run build                                   # 仓库根
node out/main/daemon.js --listen 127.0.0.1:6789 # 回环:不要令牌
node out/main/daemon.js --listen 0.0.0.0:6789   # 局域网:强制令牌,它会打印出来
```

然后 `npm run link`,它把两个要手抄的地址一起念出来(Expo Go 的 URL + 添加主机的地址和令牌)。
地址每换一次网络就变一次,别凭记忆抄。

## 手机怎么连上来

**手机和电脑必须在同一个网络里**,而且那个网络得允许两台设备互相看见。

| 场景 | 行不行 |
|---|---|
| 家里 wifi,两边都连着 | ✅ 直接用 |
| 电脑在公司 **guest 网**,手机用流量 | ❌ 两个网络,互相看不见 |
| 两边都连公司 guest 网 | ❌ guest 网基本都开**客户端隔离**,同一个网也互相不通 |
| **手机开个人热点,电脑连手机** | ✅ 最省事,下面这条 |

★ 手机开热点、电脑连过去之后,**手机↔电脑的流量是走那条本地 Wi-Fi 链路的,不走蜂窝**,
所以 Metro 那几 MB 的包不吃流量(只有电脑访问外网才走)。iOS 热点会把电脑放进 `172.20.10.x`,
`npm run link` 看见这一段会明说「对了」。

**换到热点之后两个服务都要重起**:Metro 缓存了旧的局域网地址,daemon 要重新绑 `0.0.0.0`。

`expo start --tunnel` **只解决一半**:它把 Metro 通过 ngrok 暴露出去,app 能载得进来,
但 app 要连的 daemon 还是在你电脑上、还是够不着。而把 daemon 也隧道出去等于**把整台机器的控制权
挂到公网上**(它能起 agent、能替你答权限门、能开终端),别这么干。

## Expo Go 没有扫码按钮

iOS 的 Expo Go 从 SDK 51 起**去掉了内置扫码器**。两条路:

- **用系统相机**扫终端里那个二维码,它会跳进 Expo Go(Android 的 Expo Go 还留着扫码按钮)
- Expo Go 首页 → **Enter URL manually** → 填 `npm run link` 打印的那个 `exp://…:8081`

## 目录

```
app/                  expo-router 路由 = 屏
  index.tsx           对话(根视图)· 顶栏 / 消息流 / 钉住的门 / 输入区
  sessions.tsx        全部会话,按工作区分组;挂着门的顶到最上面并染色
  hosts.tsx           主机列表与切换
  add-host.tsx        手填地址 + 令牌(扫码留到第三期)
  gate.tsx            选择题门:单选 / 多选 / 多题 + 自由输入兜底
  exec.tsx            变更 + 行级 diff
  workflow.tsx        启动工作流(选流程 / 选项目 / 写需求)
src/
  net/hostClient.ts   线协议客户端,语义照搬 src/main/remote/remoteClient.ts
  net/conn.tsx        连接与主机的 React context
  net/hosts.ts        本地存的主机 + 地址校验
  data/store.tsx      工作区 / 会话 / **门** 的统一状态
  data/useChat.ts     一个会话的消息流(历史 + chat:event)
  data/useChanges.ts  变更与 diff
  data/useWorkflow.ts 工作流状态、推进、退出、补充说明
  theme/tokens.ts     配色令牌(从原型 d.css 的 oklch 换算而来)
  ui/                 通用件,对着 d.css 的 class 一比一抄
e2e/                  无头 Chrome 界面验收,见 e2e/README.md
```

## 三件跨仓库共用的东西(不是抄过来的副本)

| 文件 | 为什么共用 |
|---|---|
| `src/shared/remote/protocol.ts` | 线协议帧 + zod 校验。开发期天天改,两份副本必然漂移 |
| `src/main/ipc/channels.ts` | 频道名(决策 11)。纯常量对象,零 import,不会连坐拽进 electron |
| `src/shared/{types,permissions,relTime}.ts` | 类型、权限档三级、相对时间。都是纯的 |

Metro 靠 `metro.config.js` 里的 `watchFolders` 看到仓库根的 `src/`,
并用 `disableHierarchicalLookup` 把依赖锁死在 `mobile/node_modules` ——
不锁的话 `../src/**` 里的 `import 'zod'` 会命中**仓库根**的 node_modules,
连带把那边的 react 也拽进来,两份 react 同时进 bundle 是 RN 里最经典的白屏。

## 怎么造一道门来验

门是这个 app 存在的唯一理由,但**它比你想的稀疏**。实测(真 CLI 数事件):

| 让 claude 干的事 | 自动(工作区) | 结果 |
|---|---|---|
| `date` / `ls` 这类 | 是 | **不升门** |
| `rm -rf /tmp/xxx` | 是 | **升门** |

原因是 Claude Code 自己会放行明显无害的操作(`~/.claude/settings.json` 的 `defaultMode`)。
所以拿 `date` 试会得出「门坏了」的错误结论 —— 要用真有副作用的:

```
用 Bash 执行:rm -rf /tmp/forge-gate-probe-dir
```

门集中在两类:**真有破坏性的操作**,以及 **选择题门**(claude 主动问你拿主意)。
codex 那边 `approval_policy` 恒 `never`,根本不弹门 —— 验门只能用 claude。

## 有意偏离设计文档的地方

**没有「三屏互斥 + 单滑动轴」。** 设计文档第十节和 `docs/mobile-design-prompt.md` 都把它写成硬约束,
但原型后来推翻了它:`directions.html` 比较了四版之后写下「**D 就是结论**」,而 D 把滑动轴换成了
**推入 / 退出层**(右上角按钮进,左上角返回,没有需要猜的手势)。理由是执行面板做成手势
= 藏进一个看不见的交互。本实现跟的是原型 D。

## 还没做

- 推送通知(要 Expo Push + daemon 直发,和第三期绑在一起)
- 终端(只读 + 降采样)—— `term:*` 还没进方法表,是跨桌面端的改动
- 语音输入、拍照上传(要原生模块,web 上验不了)
- 扫码配对(要电脑端先能生成配对码)
- 工作流的**交接稿**与**逐项目任务简报**(桌面端在跨 provider / 进执行前会让你编辑这两样)。
  手机上直接推进,用默认的自动蒸馏 —— 那是两张编辑型表单,不适合手机
- 会话内嵌 HTML 可视化现在按原文显示

## 原生(iOS / Android)

`mobile/` **就是**那两个 app —— Expo/RN 一套代码出双端,浏览器里跑的是 `react-native-web`
这条**测试通道**。所以:**浏览器里全绿 ≠ 真机上能用**。已经因此揪出过四个真机才犯的错:

| 症状(只在真机上) | 根因 |
| --- | --- |
| 第一台主机永远加不进来 | RN 自带的 `URL`,`hostname` getter 正则写死 `^https?://`,对 `ws://` 返回空串 |
| iOS/Android 根本打不出包 | `expo-asset` 没装 —— 只有原生那条入口 import 它,web 走的是另一条 |
| **release 版 Android 连不上任何主机** | `usesCleartextTraffic` 只在 **debug** manifest 里开着;API 28 起 release 默认禁明文,而我们连的是 `ws://<内网IP>` |
| iOS 连局域网被系统拒 | iOS 14 起访问局域网要 `NSLocalNetworkUsageDescription`,没有这个键系统直接拒,而且不给提示 |

前两个已修;后两个靠 `app.json` 里的 `expo-build-properties`(Android 明文)和
`ios.infoPlist`(局域网用途说明)修掉了。ATS 那半边 Expo 默认就给了 `NSAllowsLocalNetworking`。

**验这些不需要任何原生工具链**:

```bash
npm run --prefix mobile prebuild:check   # 生成 ios/ 和 android/,去里面核对 Info.plist / AndroidManifest
npx expo export --platform ios --platform android   # 让打包器真的过一遍原生目标
```

★`ios/` 和 `android/` 是 gitignore 的,看完删掉即可。
★★**`expo prebuild` 每跑一次都会把 `package.json` 里的 `ios` / `android` 两条脚本改写成
`expo run:*`** —— 那两条要 CocoaPods / JDK + Android SDK,这台机器上都没装。跑完记得
`git diff mobile/package.json` 看一眼。真要装原生走 `npm run native:ios`(需要用户在场:
CocoaPods + 签名)。

现状:Xcode ✓ / CocoaPods ✗ / Java ✗ / Android SDK ✗ —— 所以**从没在真机上装过**,
上面这些都是「照着生成出来的原生工程核对过」,不是「装到手机上跑过」。

## 已知的坑

- **令牌在这台手机上是明文存的**,并且在局域网里明文发送。第一版只建议在自己家 wifi 里用。
- 探针跑在 **node v25.7.0** 上(比 Expo 常用的 LTS 新),Metro 没出问题。
- `fontWeight` 只能给整百。原型的 680 / 660 落到 700,视觉上看不出来。
