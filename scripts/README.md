# Asset build scripts

`build-animated-pet-pack.py` combines each pet state's original 4×2 keyframe sheet from `source/` with the matching 4×2 one-third and two-thirds sheets from `inbetweens/`. It cleans and strictly interleaves those inputs into 24 independent frames, then emits GIF, WebP, APNG, and PNG outputs without repeating keyframes.

The builder requires Pillow and Codex's image-generation skill because it calls `remove_chroma_key.py` from `$CODEX_HOME/skills/.system/imagegen/scripts/`. Border sampling handles both green and magenta chroma keys. Generated assets are committed, so installing this build-only tooling is not required to run or package the app. Run `validate-pet-motion.py`, `validate-pet-alpha.py`, and `validate-pet-pack.cjs` after rebuilding a pack.

---

# macOS 正式签名 + 公证

打给别人用的 mac 包必须 **Developer ID 签名 + 公证(notarize) + 装订(staple)**，三件缺一件，
对方下载后就会看到「已损坏」或「无法验证开发者」。相关代码：

| 文件 | 干什么 |
|---|---|
| `macSigning.cjs` | 共用逻辑：`signingPlan()` 决定走哪条路、补签独立二进制、验收、公证+装订 |
| `afterPack.cjs` | 没配证书 → ad-hoc 签名（同过去）；配了 → 补签 electron-builder 漏掉的独立二进制 |
| `afterSign.cjs` | 验收签名 → 公证 `.app` → 装订 → 让 Gatekeeper 自己判一次 |
| `afterAllArtifactBuild.cjs` | 公证 + 装订 **dmg 本身**（用户下载的是它） |
| `build/entitlements.mac.plist` | hardened runtime 下 Electron 活下来的最低 entitlements |

## 密钥放哪：仓库里和环境变量里都没有密钥

只用两个环境变量，**两个都不是密钥**（能公开）：

```sh
export APPLE_SIGN_IDENTITY="Developer ID Application: 你的名字 (TEAMID)"
export FORGE_NOTARY_PROFILE="myflowforge-notary"
```

真正的密码一次性存进 **macOS 钥匙串**，之后只靠上面那个「条目名」引用：

```sh
xcrun notarytool store-credentials "myflowforge-notary" \
  --apple-id "<你的 Apple ID>" --team-id "<Team ID>" --password "<App 专用密码>"
```

从此那串密码只存在于钥匙串里 —— 不在环境变量、不在命令行、不在 shell history、不在仓库。
证书私钥同理：建证书时就落在钥匙串里，`codesign` 直接取。

★ `.gitignore` 已经挡了 `.signing.local.sh` / `*.p12` / `*.p8` / `*.cer` / `*.mobileprovision`，
但那是最后一道网。**私钥备份请放到仓库外**（密码管理器 / 加密盘）—— 一旦进了 git 历史，
删 commit 也等于泄露了，只能去苹果后台吊销证书重来。

★ 本仓库没有 CI，全部本机打包，所以不存在「密钥配进 GitHub Secrets」这一步。

## 怎么打

```sh
npm run dist:mac-all          # 两个环境变量都没设 → ad-hoc(和过去一样，Gatekeeper 会拦)
                              # 设了 → 正式签名 + 公证 + 装订，双架构 dmg
```

嫌每次 export 麻烦，可以放进 `.signing.local.sh`（已 gitignore）。**那里也只该放上面两个变量。**

## ★★两条实测踩出来的坑

**1. `APPLE_SIGN_IDENTITY` 填完整 CN，脚本会自动剥前缀。**

`security find-identity` 打印的是完整的 `Developer ID Application: 名字 (TEAMID)`，而
electron-builder **不接受这个形式**，会报
`⨯ Please remove prefix "Developer ID Application:" …`。

所以环境变量里填完整 CN（`signingPlan` 正是靠这个前缀拦住「拿开发证书当分发证书」），
`build-mac-all.sh` 再转成 electron-builder 要的形式。两边各取所需，你不用记。

**2. electron-builder 那个错误的退出码是 0。**

2026-09-15 实测:identity 形式不对时它打印 ⨯ 然后**以 0 退出**，于是整条流水线"绿着"
产出一个**完全没签名**的包（`spctl` 说 `source=no usable signature`）。而 afterSign 那套验收
在这种情况下**根本不会触发** —— 签名步骤压根没跑。

所以 `build-mac-all.sh` 在 electron-builder 返回之后**自己用 `spctl` 再判一次**，不通过就
`exit 1`。这道闸必须在构建之外，因为构建内部的钩子够不到这种失败。
★ 直接跑 `npx electron-builder --mac` 绕过脚本的话，就没有这道闸 —— 发版一律走
`npm run dist:mac-all`。

## 三道闸（都会让构建直接挂掉）

本项目最常见的故障形态是「构建全绿但包是废的」，所以这三处宁可红：

1. **不是分发证书** —— `Apple Development` / `Apple Distribution` 一律拒。用开发证书签出来的包
   本机能开、换台机器打不开，而且公证会被苹果拒。
2. **签了不公证** —— 默认拦住。用户那边照样弹「无法验证开发者」，签了等于白签。
   确实只想本地试签名：`FORGE_ALLOW_UNNOTARIZED=1`。
3. **有原生二进制没签到** —— 签完全量扫 `Contents/Resources` 的 Mach-O，逐个查
   「已签名 / 是我们的证书 / 开了 hardened runtime」。
   ★`node-pty` 的 `spawn-helper` **没有后缀**，正好在 electron-builder 遍历的盲区；
   漏了它**公证照样通过、包也打得开，只有终端是坏的**。

## 其它开关

- `FORGE_SKIP_DMG_NOTARIZE=1` —— 试构建时跳过 dmg 那一遍公证（省一次 ~170MB 上传）。
  **正式发版别开**，用户下载的就是 dmg。
