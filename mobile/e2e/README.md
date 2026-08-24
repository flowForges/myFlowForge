# 手机端界面验收

跑的是**真界面 + 真线协议**,只有对面那台机器是假的。

```
终端 1   cd mobile && npm run web            # Expo web(react-native-web)
终端 2   cd mobile && npm run e2e:flow       # 门:升起 → 答 → 下一道 → 选择题 → 提交
         cd mobile && npm run e2e:offline    # 断线:显式、按钮置灰、已加载内容仍可读
```

## 为什么是 web + 无头 Chrome

真机和模拟器留给白天。这台构建机上一个 iOS 模拟器运行时都没装(下一个几个 GB),
也没有 watchman / cocoapods / Java。而对**版式和状态**来说,react-native-web 够用且迭代快得多:
同一份组件、同一套令牌、同一份协议代码。

真机特有的东西(安全区、键盘遮挡、返回手势、推送)web 上验不了,得留到真机。

## mock-daemon.mjs

说的是 `src/shared/remote/protocol.ts` 那套真帧(hello / ready / req / res / evt),
数据是编的,而且能按脚本在指定时刻升门。

要它的原因:门是手机端存在的唯一理由,而真门要真代理真跑一轮才升得起来 —— 慢、烧配额,
更要命的是**没法复现边角**:两道门同时挂着、门来自另一个会话、别人先答了、答完下一道顶上来。

也可以对着**真 daemon** 跑(`node out/main/daemon.js --listen 127.0.0.1:6789`),
读真实工作区和会话;只是门得自己想办法升。
