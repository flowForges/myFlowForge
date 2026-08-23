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

要有东西可看,先在电脑上把 daemon 起起来:

```bash
npm run build                                   # 仓库根
node out/main/daemon.js --listen 127.0.0.1:6789 # 回环:不要令牌
node out/main/daemon.js --listen 0.0.0.0:6789   # 局域网:强制令牌,它会打印出来
```

然后在 app 里「添加主机」,填 `192.168.x.x:6789` + 令牌。

## 目录

```
app/                  expo-router 路由 = 屏
  index.tsx           对话(根视图)· 顶栏 / 消息流 / 钉住的门 / 输入区
  sessions.tsx        全部会话,按工作区分组;挂着门的顶到最上面并染色
  hosts.tsx           主机列表与切换
  add-host.tsx        手填地址 + 令牌(扫码留到第三期)
  gate.tsx            选择题门:单选 / 多选 / 多题 + 自由输入兜底
  exec.tsx            变更 + 行级 diff
src/
  net/hostClient.ts   线协议客户端,语义照搬 src/main/remote/remoteClient.ts
  net/conn.tsx        连接与主机的 React context
  net/hosts.ts        本地存的主机 + 地址校验
  data/store.tsx      工作区 / 会话 / **门** 的统一状态
  data/useChat.ts     一个会话的消息流(历史 + chat:event)
  data/useChanges.ts  变更与 diff
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

## 有意偏离设计文档的地方

**没有「三屏互斥 + 单滑动轴」。** 设计文档第十节和 `docs/mobile-design-prompt.md` 都把它写成硬约束,
但原型后来推翻了它:`directions.html` 比较了四版之后写下「**D 就是结论**」,而 D 把滑动轴换成了
**推入 / 退出层**(右上角按钮进,左上角返回,没有需要猜的手势)。理由是执行面板做成手势
= 藏进一个看不见的交互。本实现跟的是原型 D。

## 还没做

- 启动工作流 / 阶段进度 / 补充说明
- 推送通知(要 Expo Push + daemon 直发,和第三期绑在一起)
- 终端(只读 + 降采样)、文件浏览
- 语音输入、拍照上传(要原生模块,web 上验不了)
- 扫码配对(要电脑端先能生成配对码)
- 消息流里的工具卡 / 委派批次 —— 现在只画正文和思考
- 会话内嵌 HTML 可视化现在按原文显示

## 已知的坑

- **令牌在这台手机上是明文存的**,并且在局域网里明文发送。第一版只建议在自己家 wifi 里用。
- 探针跑在 **node v25.7.0** 上(比 Expo 常用的 LTS 新),Metro 没出问题。
- `fontWeight` 只能给整百。原型的 680 / 660 落到 700,视觉上看不出来。
