#!/usr/bin/env node
/*
 * 原生可用性自检 —— **把今天在真机上撞出来的坑,变成一条命令就能重现的检查。**
 *
 * 背景:`mobile/` 就是 iOS + Android 两个 app,但日常验证全在 `react-native-web` 上。
 * web 通道**不编译原生代码、不合并 manifest、不读 Info.plist**,所以下面这几类问题
 * 它一个都照不出来 —— 而它们全都是「装上去也用不了」级别的:
 *
 *   1. 依赖只在原生入口被 import(expo-asset)→ 原生根本打不出包
 *   2. release 和 debug 的 manifest 不一样(usesCleartextTraffic)→ release 包连不上任何主机
 *   3. iOS 权限键缺失(NSLocalNetworkUsageDescription)→ 系统静默拒绝局域网访问
 *   4. 传递依赖版本漂移(reanimated/worklets)→ iOS 编译直接失败
 *   5. Expo 钉的版本和实际装的对不上
 *
 * ★这个脚本**不需要任何原生工具链**(不用 CocoaPods、不用 JDK、不用 Android SDK)。
 *  `expo export` 让打包器真的过一遍原生目标;`expo prebuild` 生成原生工程好让我们直接读
 *  合并后的 plist / manifest。两者都只是生成文件。
 *
 * ★★副作用警告:`expo prebuild` **每次都会把 package.json 里的 ios/android 脚本改写成
 *  `expo run:*`**。本脚本跑完会自己改回去,并在改动时明确告诉你。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let bad = 0
const ok = (label, cond, extra = '') => {
  if (!cond) bad++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)
}
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

const pkgPath = path.join(ROOT, 'package.json')
const pkgBefore = fs.readFileSync(pkgPath, 'utf8')

// ★★进来之前 ios/ android/ 就已经存在的话,说明**有人正在用它们做原生开发**
//  (选过 Team、装过 Pods、可能还开着 Xcode)。那就绝不能在收尾时删掉 ——
//  自检是只读的检查,不该毁掉别人手上的活。我第一版就是这么把自己的构建目录端了的,
//  而且因为 `cmd | tail` 吞掉了退出码,还以为编译成功了。
const iosPre = fs.existsSync(path.join(ROOT, 'ios'))
const androidPre = fs.existsSync(path.join(ROOT, 'android'))
if (iosPre || androidPre) {
  console.log(`(检测到已有原生工程:${[iosPre && 'ios/', androidPre && 'android/'].filter(Boolean).join(' ')} —— 自检结束后**不会**删除)`)
}

// ── ① 依赖版本必须和 Expo 为这个 SDK 钉的一致 ────────────────────────────────
// 这一条抓的是 reanimated 4.6.0 那一类:expo-router 的 peer 写成 "*",npm 装最新,
// 于是 worklets 跳到 0.12,而 expo-modules-core 的 C++ 还在调 0.10 才有的 executeSync。
console.log('── 依赖版本 ──')
try {
  const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/expo/bundledNativeModules.json'), 'utf8'))
  const deps = JSON.parse(pkgBefore).dependencies ?? {}
  const drifted = []
  for (const [name, want] of Object.entries(bundled)) {
    if (!fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json'))) continue
    const got = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version
    const wantClean = String(want).replace(/^[~^]/, '')
    // 只比主次版本 —— Expo 钉的是 `~x.y.z` / `^x.y.z`,补丁号允许动
    const [wM, wm] = wantClean.split('.')
    const [gM, gm] = got.split('.')
    if (wM !== gM || wm !== gm) drifted.push(`${name}: 装的 ${got},Expo 钉的 ${want}${deps[name] ? '' : '(传递依赖)'}`)
  }
  ok('装的原生模块版本和 Expo 为这个 SDK 钉的一致', drifted.length === 0, drifted.join(' / '))
} catch (e) {
  ok('读得到 bundledNativeModules', false, String(e.message).slice(0, 80))
}

// npm 自己标 invalid 的,一律算问题
try {
  run('npm', ['ls', '--all'], { stdio: ['ignore', 'pipe', 'ignore'] })
  ok('npm 依赖树没有 invalid', true)
} catch (e) {
  const out = String(e.stdout ?? '')
  const invalid = out.split('\n').filter((l) => l.includes('invalid:')).slice(0, 3)
  ok('npm 依赖树没有 invalid', invalid.length === 0, invalid.join(' / '))
}

// ── ② 原生打包器必须真的过一遍 ───────────────────────────────────────────────
console.log('\n── 原生打包(不需要工具链)──')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-native-check-'))
try {
  const out = run('npx', ['expo', 'export', '--platform', 'ios', '--platform', 'android', '--output-dir', outDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  ok('iOS 能打出 bundle', /iOS Bundled/.test(out))
  ok('Android 能打出 bundle', /Android Bundled/.test(out))
} catch (e) {
  const msg = String(e.stdout ?? '') + String(e.stderr ?? '')
  const first = msg.split('\n').find((l) => /Unable to resolve|error/i.test(l)) ?? msg.slice(0, 120)
  ok('两个原生目标都能打出 bundle', false, first.trim())
} finally {
  fs.rmSync(outDir, { recursive: true, force: true })
}

// ── ③ 生成原生工程,直接读合并后的配置 ───────────────────────────────────────
// ★这是**唯一**能看见「release 和 debug 不一样」的办法。
console.log('\n── 原生工程配置 ──')
try {
  run('npx', ['expo', 'prebuild', '--no-install', '--platform', 'ios'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const plist = fs.readFileSync(path.join(ROOT, 'ios/myFlowForge/Info.plist'), 'utf8')
  ok('iOS 有 NSLocalNetworkUsageDescription(iOS 14+ 没有它,系统静默拒绝局域网)',
    plist.includes('NSLocalNetworkUsageDescription'))
  ok('iOS 允许局域网明文(NSAllowsLocalNetworking)', /NSAllowsLocalNetworking<\/key>\s*<true\/>/.test(plist))
  ok('iOS 没有把 ATS 整个放开(NSAllowsArbitraryLoads 应为 false)',
    /NSAllowsArbitraryLoads<\/key>\s*<false\/>/.test(plist))
  // ★缺这条 iOS 是**当场崩**,不是弹个框说不给用 —— 而且只在人点「扫一扫」那一下才崩,
  //  日常在 web 上点来点去一辈子撞不到。
  //  ★★查的是**我们自己那句话**,不是这个键存不存在:expo-camera 装上之后,自动链接会替你
  //   补一条英文默认文案(`Allow $(PRODUCT_NAME) to access your camera`),所以只查键名的话,
  //   app.json 里那条插件配置被删掉也照样绿 —— 而现象是中文 app 弹一句英文要权限。
  ok('iOS 相机权限用的是我们自己写的中文文案(不是 expo-camera 的英文默认)',
    /NSCameraUsageDescription<\/key>\s*<string>myFlowForge [^<]*扫一扫/.test(plist),
    plist.includes('access your camera') ? 'app.json 里 expo-camera 那条插件配置没生效' : '')
  // ★★和相机那条同一个理由:查的是**我们自己那句中文**,不是键名。
  //  expo-image-picker 的自动链接会替你补一条英文默认(`Allow $(PRODUCT_NAME) to access your photos`),
  //  只查键名的话,app.json 里那条插件配置被删掉也照样绿 —— 现象是中文 app 弹一句英文要权限。
  ok('iOS 相册权限用的是我们自己写的中文文案(不是 expo-image-picker 的英文默认)',
    /NSPhotoLibraryUsageDescription<\/key>\s*<string>myFlowForge [^<]*相册/.test(plist),
    plist.includes('access your photos') ? 'app.json 里 expo-image-picker 那条插件配置没生效' : '')
  const pbx = fs.readFileSync(path.join(ROOT, 'ios/myFlowForge.xcodeproj/project.pbxproj'), 'utf8')
  ok('iOS 工程里带着 Team(否则每次重建都要手点一次)', /DEVELOPMENT_TEAM = \w+;/.test(pbx))
} catch (e) {
  ok('iOS 原生工程生成 + 配置核对', false, String(e.message).slice(0, 120))
}

try {
  run('npx', ['expo', 'prebuild', '--no-install', '--platform', 'android'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const manifest = fs.readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8')
  // ★★这一条是今天最值钱的:usesCleartextTraffic 只写在 debug manifest 里的话,
  //   release 包在 API 28+ 上根本连不上 ws://<内网IP>,而 debug 包一切正常。
  ok('★Android 主 manifest 里有 usesCleartextTraffic(release 包才连得上 ws://)',
    /android:usesCleartextTraffic="true"/.test(manifest),
    manifest.includes('usesCleartextTraffic') ? '' : '只在 debug manifest 里 = release 包连不上任何主机')
  // 这一条只挡得住「expo-camera 被整个删掉」——自动链接会自己补 CAMERA 权限,
  // 所以 app.json 里那条插件配置没了它照样绿(iOS 那条查的是文案,能挡住)。
  ok('Android 有 CAMERA 权限(扫一扫用)', manifest.includes('android.permission.CAMERA'))
  ok('Android 有 INTERNET 权限', manifest.includes('android.permission.INTERNET'))
  // ★★2026-08-29 真机:安卓上「设置里选浅色没反应」。根因不在 JS —— `forceDarkAllowed`
  //   在 API 29+ 默认为 true,系统开深色模式时会在**原生层**把我们画好的浅色又反色回去。
  //   国产 ROM 的深色开关尤其激进。iOS 上没有这个机制,所以这个 bug 只在安卓上现形。
  //   `plugins/withNoForceDark.js` 负责关掉它;这条断言保证它**真的落到了 styles.xml 里** ——
  //   plugin 静默不生效(比如 Expo 改了主题名字)是这里唯一防得住的失败方式。
  const styles = fs.readFileSync(path.join(ROOT, 'android/app/src/main/res/values/styles.xml'), 'utf8')
  const noForceDark = /<item name="android:forceDarkAllowed">false<\/item>/.test(styles)
  // ★提示语要**条件给**:`ok()` 是无条件打印第三个参数的(见上面 usesCleartextTraffic 那条
  //  的写法),常量传进去的话每一次 PASS 后面都跟着一句失败提示,读起来像没过。
  ok('★★Android 关掉了强制深色(否则设置里的浅色会被系统反色回去)',
    noForceDark,
    noForceDark ? '' : 'plugins/withNoForceDark.js 没生效')
  // ★同名 style 出现两次 = 后一个整个顶掉前一个(那正是这个 plugin 第一版干的事:
  //   用 assignStylesValue 传了个对不上的 parent,于是新建了第二个 AppTheme,
  //   把 colorPrimary 和透明状态栏一起丢了)。
  ok('★Android styles.xml 里没有重名的 AppTheme',
    (styles.match(/<style name="AppTheme"/g) ?? []).length === 1)
} catch (e) {
  ok('Android 原生工程生成 + manifest 核对', false, String(e.message).slice(0, 120))
}

// ── ④ 收拾 prebuild 的副作用 ─────────────────────────────────────────────────
// 只删**我们自己生成的**。进来之前就有的是别人的活,不能碰。
if (!iosPre) fs.rmSync(path.join(ROOT, 'ios'), { recursive: true, force: true })
if (!androidPre) fs.rmSync(path.join(ROOT, 'android'), { recursive: true, force: true })
const pkgAfter = fs.readFileSync(pkgPath, 'utf8')
if (pkgAfter !== pkgBefore) {
  fs.writeFileSync(pkgPath, pkgBefore)
  console.log('\n(已复原 package.json —— expo prebuild 每次都会把 ios/android 脚本改写成 expo run:*)')
}

console.log(bad === 0 ? '\n原生自检全部通过' : `\n${bad} 项没过`)
process.exit(bad === 0 ? 0 : 1)
