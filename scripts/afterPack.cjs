// electron-builder afterPack hook（macOS）。按有没有配 Developer ID 分两条路：
//
// ── 没配（今天的默认）: ad-hoc 签名 ─────────────────────────────────────────────────
// 一个*完全没签名*的 macOS app 不会被通知守护进程(usernoted)登记 —— 拿不到权限弹窗、不出现在
// 系统设置→通知里、每一条横幅都静默失效。**ad-hoc** 签名(`codesign --sign -`)给包一个稳定的
// 代码签名身份(cdhash)，足够让 macOS 登记它、让通知能用。它**不会**消掉 Gatekeeper 的
// 「身份不明的开发者 / 已损坏」警告 —— 那要真证书 + 公证。
//
// ── 配了 APPLE_SIGN_IDENTITY: 补签 electron-builder 认不出来的独立二进制 ──────────────
// 这一步**必须在 afterPack**（而不是 afterSign）：electron-builder 的顺序是
// 打包 → afterPack → 它自己签名 → afterSign。我们先把盲区文件签好，它随后签外层 bundle 时
// 正好把这些封进去，不需要事后重签。
//
// afterPack 而不是 afterSign 的另一个理由：`identity: null` 时 electron-builder 整个跳过签名步骤，
// afterSign 可能根本不触发；afterPack 在 .app 组装完、dmg 还没打之前一定会跑。

const { execFileSync } = require('node:child_process')
const { join, basename, resolve } = require('node:path')
const { existsSync } = require('node:fs')
const { signingPlan, machOFilesUnder, signBinary } = require('./macSigning.cjs')
const { verifyPackagedDeps } = require('./packagedDeps.cjs')
const { applyWinResources } = require('./winResources.cjs')

/** 打好的 app 里那个放 out/ 和 node_modules 的目录。mac 藏在 .app 里，其余平台在 resources/app。 */
function appResourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    return join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app')
  }
  return join(context.appOutDir, 'resources', 'app')
}

exports.default = async function afterPack(context) {
  // ── 所有平台都先过这道闸 ───────────────────────────────────────────────────────────
  // electron-builder 只打 dependencies。一个运行时依赖被写进 devDependencies（或被从
  // dependencies 挪走），开发时**完全正常**，只有用户装上包才会炸 Cannot find module。
  // 本机手工打包，没有别的地方能拦住它。
  const appDir = appResourcesDir(context)
  if (existsSync(appDir)) verifyPackagedDeps(appDir)
  else console.warn(`[deps] 找不到 ${appDir}，跳过运行时依赖检查`)

  // ── Windows:图标 + 版本信息(替代 electron-builder 那条「wine 跑 rcedit」的路,理由见 winResources.cjs)
  //    ★写不进去就**让构建失败**。以前那条路失败时会重试、全部超时才报错,而一个没有图标、
  //     属性里写着 "Electron" 的 exe 装上去照样能跑 —— 那是最难被发现的一类坏包。
  if (context.electronPlatformName === 'win32') {
    const info = context.packager.appInfo
    const exeName = `${info.productFilename}.exe`
    const exePath = join(context.appOutDir, exeName)
    const icoPath = resolve(context.packager.info.projectDir, context.packager.platformSpecificBuildOptions.icon || 'build/icon.ico')
    if (!existsSync(exePath)) throw new Error(`[afterPack] 找不到 ${exePath} —— electronDist 是不是给成了别的平台的 Electron?`)
    if (!existsSync(icoPath)) throw new Error(`[afterPack] 找不到图标 ${icoPath}`)
    applyWinResources(exePath, {
      icoPath,
      version: info.version,
      productName: info.productName,
      companyName: info.companyName || info.productName,
      description: info.description || info.productName,
      copyright: info.copyright,
      exeName,
    })
    console.log(`[afterPack] ✓ ${exeName}:图标 + 版本 ${info.version} 已写入(resedit,不经 wine)`)
    return
  }

  if (context.electronPlatformName !== 'darwin') return
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = join(context.appOutDir, appName)
  if (!existsSync(appPath)) {
    console.warn(`[afterPack] .app not found at ${appPath}; skipping sign`)
    return
  }

  const plan = signingPlan()

  if (plan.mode === 'adhoc') {
    // --force: 覆盖已有签名。--deep: 连嵌套的 helper/framework 一起签。--sign -: ad-hoc（无证书）。
    // --timestamp=none: ad-hoc 签名没法向苹果的时间戳服务取时间戳。
    console.log(`[afterPack] ad-hoc signing ${appName}（未配 APPLE_SIGN_IDENTITY；只为让本机通知能用）…`)
    try {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' })
      execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' })
      console.log('[afterPack] ad-hoc signature applied.')
    } catch (e) {
      // codesign 不可用时别让整个构建挂 —— 只是警告（通知会坏，但包还能用）。
      console.warn(`[afterPack] ad-hoc sign failed: ${e && e.message ? e.message : e}`)
    }
    return
  }

  // ── Developer ID：补签 electron-builder 遍历时认不出来的独立 Mach-O ──────────────────
  //
  // 它认的是「一看就是代码」的东西：.app / .framework / .dylib / .node / Contents/MacOS 下的可执行文件。
  // node-pty 的 `prebuilds/darwin-<arch>/spawn-helper` **没有后缀、躺在 Resources 里**，正好在盲区。
  // 而我们 `asar: false`，原生模块是摊开的裸文件，更容易被漏。
  //
  // ★★漏掉它是本项目最经典的那种假绿：公证照样通过（苹果只查它认出来的代码），包也装得上、打得开，
  //   但**终端一开就挂** —— node-pty 拉不起一个没签名的 helper。afterSign 会再全量验一遍兜底。
  const resources = join(appPath, 'Contents', 'Resources')
  const naked = machOFilesUnder(resources).filter((p) => !/\.(node|dylib|so)$/.test(p))
  if (!naked.length) {
    console.log('[afterPack] Resources 下没有无后缀的独立二进制，无需补签')
    return
  }
  console.log(`[afterPack] 用 ${plan.identity} 补签 ${naked.length} 个独立二进制：`)
  for (const f of naked) {
    console.log(`[afterPack]   · ${basename(f)}  (${f.slice(appPath.length + 1)})`)
    signBinary(f, plan.identity)
  }
}
