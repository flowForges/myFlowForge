const { withDangerousMod } = require('expo/config-plugins')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * `pod install` 里的一道闸:**React Native 核心用了预编译包,依赖却在源码编译 ⇒ 当场失败。**
 *
 * ★★★2026-09-21 事故:TestFlight 1.2.1(build 4)一启动就崩,没有一行 JS 跑起来 ——
 *  dyld 报 `Library not loaded: @rpath/ReactNativeDependencies.framework/ReactNativeDependencies`。
 *
 *  RN 0.86 的 `pod install` 会**各自联网**去 Maven 确认两份预编译包在不在(核心一次、依赖一次,
 *  见 node_modules/react-native/scripts/cocoapods/{rncore,rndependencies}.rb 里的 artifact_exists)。
 *  那天网络不稳:核心那次查到了,依赖那次没查到(curl 没设超时,连不上就返回 000,当成「不存在」),
 *  于是依赖**悄悄**改成源码编译,只打一行日志。可预编译的 React.framework 是**链接着**
 *  ReactNativeDependencies.framework 的,而源码那条路根本不产出这个框架 —— 嵌入脚本里没它,包里没它。
 *  构建、归档、导出、苹果校验、上传**全部是绿的**:它们都不会真的把 app 加载起来。
 *
 * ★为什么是「失败」而不是「自动改成两边都走源码」:这件事的本质是**同一次安装里,两个决定由两次
 *  独立的网络请求各自做出**。自动纠偏等于接受「这次装出来是哪种组合取决于网络运气」。
 *  失败了重跑一次 `pod install` 就会重新判断(scripts/build-ios.sh 自动重试),结果是确定的。
 *
 * ★为什么必须是 config plugin:`expo prebuild` 会重新生成整个 ios/(ios/ 在 .gitignore 里),
 *  直接改 Podfile 下一次就没了。理由同 withReleaseSigning.js。
 */

const MARKER = '# myFlowForge: prebuilt React Native consistency guard (withPrebuiltRNGuard.js)'

const GUARD = `
    ${MARKER}
    __ff_pods = installer.pod_targets.map(&:name)
    __ff_core_prebuilt = __ff_pods.include?('React-Core-prebuilt')
    __ff_deps_prebuilt = __ff_pods.include?('ReactNativeDependencies')
    if __ff_core_prebuilt && !__ff_deps_prebuilt
      raise Pod::Informative, [
        '[myFlowForge] React Native 核心用的是预编译包,依赖却退回了源码编译。',
        '  预编译的 React.framework 链接着 ReactNativeDependencies.framework,而源码那条路不产出它 ——',
        '  这样打出来的 app 一启动就被 dyld 终止(2026-09-21 TestFlight build 4 就是这么崩的)。',
        '  最常见的原因:pod install 联网确认依赖预编译包时没连上(看上面有没有',
        '  "No prebuilt artifacts found, reverting to building from source")。重跑一次 pod install。',
      ].join("\\n")
    end
    Pod::UI.puts "[myFlowForge] ✓ React Native 核心/依赖一致:核心#{__ff_core_prebuilt ? '预编译' : '源码'} · 依赖#{__ff_deps_prebuilt ? '预编译' : '源码'}"
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
