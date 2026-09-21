const { withDangerousMod } = require('expo/config-plugins')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * `pod install` 里的一道闸:**装出来的 React Native 核心 / 依赖 / Expo 预编译模块三者对不上 ⇒ 当场失败。**
 *   · 核心预编译、依赖却是源码(2026-09-21 TestFlight build 4 事故)
 *   · 装了 Expo 预编译模块、核心却是源码(同一天 1.2.2 第一次打包,被链接闸 scripts/verify-ios-app.sh 拦下)
 *
 * ★★★build 4 一启动就崩,没有一行 JS 跑起来 ——
 *  dyld 报 `Library not loaded: @rpath/ReactNativeDependencies.framework/ReactNativeDependencies`。
 *
 *  RN 0.86 的 `pod install` 会**各自联网**去 Maven 确认两份预编译包在不在(核心一次、依赖一次,
 *  见 node_modules/react-native/scripts/cocoapods/{rncore,rndependencies}.rb 里的 artifact_exists)。
 *  网络不稳时两次结果可以不一样(curl 没设超时,连不上就返回 000,当成「不存在」),没查到的那一半
 *  **悄悄**改成源码编译,只打一行日志。而 Expo 要不要用预编译模块,只看 RCT_USE_PREBUILT_RNCORE 这个
 *  **环境变量**,不看核心实际装成了什么。于是三者可以组合出好几种「全绿但装上就崩」的包:
 *   · 预编译的 React.framework(和所有预编译 Expo 模块)链接着 ReactNativeDependencies.framework,
 *     源码依赖不产出它 —— build 4;
 *   · 预编译 Expo 模块链接着 React.framework,源码核心不产出它 —— 1.2.2 第一次打包。
 *  构建、归档、导出、苹果校验、上传**全部是绿的**:它们都不会真的把 app 加载起来。
 *
 * ★判断全部基于**装出来的 pod**,不看环境变量 —— 只看环境变量正是 Expo 出错的原因。
 *
 * ★为什么是「失败」而不是「自动改成两边都走源码」:本质是**同一次安装里,几个决定由几次独立的
 *  网络请求各自做出**。自动纠偏等于接受「这次装出来是哪种组合取决于网络运气」。失败了重跑一次
 *  `pod install` 就会重新判断(scripts/build-ios.sh 自动重试),结果是确定的。
 *
 * ★为什么必须是 config plugin:`expo prebuild` 会重新生成整个 ios/(ios/ 在 .gitignore 里),
 *  直接改 Podfile 下一次就没了。理由同 withReleaseSigning.js。
 */

const MARKER = '# myFlowForge: prebuilt React Native consistency guard (withPrebuiltRNGuard.js)'

// ★这是一段 Ruby,放在 JS 模板字符串里:Ruby 的 "\n" 要写成 "\\n";Ruby 的 #{} 插值 JS 不认,原样保留。
const GUARD = `
    ${MARKER}
    __ff_pods = installer.pod_targets.map(&:name)
    __ff_core_prebuilt = __ff_pods.include?('React-Core-prebuilt')
    __ff_deps_prebuilt = __ff_pods.include?('ReactNativeDependencies')
    # 真正装进来的 Expo 预编译模块 = 带 xcframework 的 Expo* pod。★看装出来的,不看 EXPO_USE_PRECOMPILED_MODULES。
    __ff_expo_xcf = installer.pod_targets
      .select { |t| t.name.start_with?('Expo') && t.respond_to?(:xcframeworks) && t.xcframeworks.values.flatten.any? }
      .map(&:name)
    if __ff_core_prebuilt && !__ff_deps_prebuilt
      raise Pod::Informative, [
        '[myFlowForge] React Native 核心用的是预编译包,依赖却退回了源码编译。',
        '  预编译的 React.framework 链接着 ReactNativeDependencies.framework,而源码那条路不产出它 ——',
        '  这样打出来的 app 一启动就被 dyld 终止(2026-09-21 TestFlight build 4 就是这么崩的)。',
        '  最常见的原因:pod install 联网确认依赖预编译包时没连上(看上面有没有',
        '  "No prebuilt artifacts found, reverting to building from source")。重跑一次 pod install。',
      ].join("\\n")
    end
    if !__ff_expo_xcf.empty? && !__ff_core_prebuilt
      raise Pod::Informative, [
        "[myFlowForge] 装了 Expo 的预编译模块(#{__ff_expo_xcf.first(3).join(', ')} 等 #{__ff_expo_xcf.size} 个),React Native 核心却退回了源码编译。",
        '  这些模块链接着预编译的 React.framework,源码核心不产出它 —— 打出来的 app 一启动就被 dyld 终止。',
        '  最常见的原因:pod install 联网确认核心预编译包时没连上。重跑一次 pod install。',
      ].join("\\n")
    end
    Pod::UI.puts "[myFlowForge] ✓ 一致:核心#{__ff_core_prebuilt ? '预编译' : '源码'} · 依赖#{__ff_deps_prebuilt ? '预编译' : '源码'} · Expo 预编译模块 #{__ff_expo_xcf.size} 个"
`

function injectGuard(podfile) {
  if (podfile.includes(MARKER)) return podfile          // 幂等:prebuild 可能跑多次
  const hook = /post_install do \|installer\|\n/
  if (!hook.test(podfile)) {
    // ★找不到挂点就让 prebuild 失败 —— 静默跳过等于这道闸不存在,而表面上一切正常。
    throw new Error('[withPrebuiltRNGuard] Podfile 里找不到 `post_install do |installer|`,Expo 模板变了?')
  }
  return podfile.replace(hook, (m) => `${m}${GUARD}`)
}

module.exports = function withPrebuiltRNGuard(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const path = join(cfg.modRequest.platformProjectRoot, 'Podfile')
      writeFileSync(path, injectGuard(readFileSync(path, 'utf8')))
      return cfg
    },
  ])
}

module.exports.injectGuard = injectGuard
module.exports.MARKER = MARKER
