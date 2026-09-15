// macOS 正式签名 + 公证的共用逻辑。被 afterPack / afterSign / afterAllArtifactBuild 三个
// electron-builder 钩子调用。
//
// ── 密钥怎么存：一句话，仓库里、环境变量里，都没有任何密钥 ────────────────────────────────
//
// 这套东西只认两个环境变量，**两个都不是密钥**，写进 shell 配置、贴进聊天记录、被人看到都无所谓：
//
//   APPLE_SIGN_IDENTITY   证书的名字，形如 "Developer ID Application: zhu guohua (TEAMID)"。
//                         这串东西**本来就印在每一个签过名的 app 里**，`codesign -dv` 谁都能读出来。
//   FORGE_NOTARY_PROFILE  钥匙串里一个凭据条目的**名字**（不是密码），例如 "myflowforge-notary"。
//
// 真正的密钥有两样，它们都**不经过这里**：
//
//   ① App 专用密码（公证用）
//      一次性存进 macOS 钥匙串：
//        xcrun notarytool store-credentials "myflowforge-notary" \
//          --apple-id "你的@apple.id" --team-id "TEAMID" --password "xxxx-xxxx-xxxx-xxxx"
//      之后构建只传 `--keychain-profile myflowforge-notary` 这个**名字**。密码从此只存在于钥匙串里，
//      不在环境变量、不在命令行、不在 shell history、不在这个仓库。
//
//   ② 证书私钥（.p12）
//      建证书时自动落在钥匙串里，签名时 codesign 直接从钥匙串取。**永远不要把 .p12 放进仓库目录** ——
//      .gitignore 已经挡了 `*.p12`，但那是最后一道网，不是第一道。备份请放到仓库外（密码管理器 / 加密盘）。
//
// ★ 这个仓库没有 CI（没有 .github/workflows），全部在本机打包。所以不存在「把密钥配进 GitHub Secrets」
//   这一步，也就不存在从那里泄露的可能。哪天要上 CI，再单独设计，别把密码塞进 env。
//
// ── 不配任何变量会怎样 ──────────────────────────────────────────────────────────────
// 和今天完全一样：ad-hoc 签名（只为了让本机通知能注册），Gatekeeper 照样拦。现有的 `npm run dist`
// 行为一个字节都没变。

const { execFileSync, spawnSync } = require('node:child_process')
const { readdirSync, openSync, readSync, closeSync, mkdtempSync, rmSync } = require('node:fs')
const { join, basename } = require('node:path')
const { tmpdir } = require('node:os')

const ENTITLEMENTS = 'build/entitlements.mac.plist'

/**
 * 从环境变量推出这次构建该怎么签。**纯函数**，好让 macSigning.test.cjs 把分支钉死 ——
 * 这里每一个分支走错的后果都是「构建绿了但包是废的」，正是本项目最该防的那类假绿。
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{mode:'adhoc'} | {mode:'developer-id', identity:string, notaryProfile:string|null, skipDmgNotarize:boolean}}
 */
function signingPlan(env = process.env) {
  const identity = String(env.APPLE_SIGN_IDENTITY ?? '').trim()
  if (!identity) return { mode: 'adhoc' }

  // ★★只有 "Developer ID Application" 能用于**在 App Store 之外分发**。
  //  这台机器的钥匙串里同时躺着一张 "Apple Development: …"(真机调试用)，名字长得很像，
  //  复制粘贴或者让 electron-builder 自动发现时极易摸错。用它签出来的包：
  //  构建全绿、本机双击能开(因为本机信任自己的开发证书)、**换一台机器就打不开**，
  //  而且公证会被苹果直接拒。所以在这里就拦死，别等发出去才发现。
  //  (codesign 也接受 40 位 SHA-1 指纹，那种形式放行。)
  if (!/^Developer ID Application/i.test(identity) && !/^[0-9a-f]{40}$/i.test(identity)) {
    throw new Error(
      `APPLE_SIGN_IDENTITY 不是分发证书：「${identity}」\n` +
      '  对外分发只能用 "Developer ID Application: 你的名字 (TEAMID)"。\n' +
      '  · "Apple Development: …"  = 真机调试证书，换台机器就打不开，公证会被拒\n' +
      '  · "Apple Distribution: …" = 上架 App Store 用的，不能用来自己发 dmg\n' +
      '  看看你有哪些： security find-identity -v -p codesigning',
    )
  }

  const notaryProfile = String(env.FORGE_NOTARY_PROFILE ?? '').trim()
  const allowUnnotarized = String(env.FORGE_ALLOW_UNNOTARIZED ?? '') === '1'
  // ★★签了名但不公证 = **用户那边照样弹「无法验证开发者」**，而构建是全绿的。这是这条链路上
  //  最容易骗过自己的一步（「我证书都装好了啊」），所以默认直接拦住，要跳过必须显式说出口。
  if (!notaryProfile && !allowUnnotarized) {
    throw new Error(
      'APPLE_SIGN_IDENTITY 配了但 FORGE_NOTARY_PROFILE 没配。\n' +
      '  只签名不公证的包，用户下载后仍会看到「无法验证开发者」——签了等于白签。\n' +
      '  先跑一次： xcrun notarytool store-credentials "myflowforge-notary" \\\n' +
      '               --apple-id "<你的 Apple ID>" --team-id "<Team ID>" --password "<App 专用密码>"\n' +
      '  然后 export FORGE_NOTARY_PROFILE=myflowforge-notary\n' +
      '  确实只想本地试签名（不打算发出去），用 FORGE_ALLOW_UNNOTARIZED=1 显式跳过。',
    )
  }
  return {
    mode: 'developer-id',
    identity,
    notaryProfile: notaryProfile || null,
    // 公证要把 170MB 的产物整个传给苹果。app 和 dmg 各传一次，国内网络下这是实打实的等待，
    // 所以留一个只在**试构建**时用的开关。正式发版别开 —— 用户下载的是 dmg。
    skipDmgNotarize: String(env.FORGE_SKIP_DMG_NOTARIZE ?? '') === '1',
  }
}

const MACHO_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

/** 这个文件是不是 Mach-O（可执行 / 动态库 / .node）。只读前 4 个字节，几千个文件也就几百毫秒。 */
function isMachO(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(4)
    if (readSync(fd, buf, 0, 4, 0) < 4) return false
    return MACHO_MAGICS.has(buf.readUInt32BE(0)) || MACHO_MAGICS.has(buf.readUInt32LE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
  }
}

/** 递归收集 dir 下所有 Mach-O 文件。软链接不跟（Electron 框架里全是指回自己的软链）。 */
function machOFilesUnder(dir) {
  const out = []
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && isMachO(p)) out.push(p)
    }
  }
  walk(dir)
  return out
}

/**
 * 签一个**独立的** Mach-O 文件（不是 bundle）。
 *
 * ★★为什么需要这个：electron-builder 自己那套签名会遍历 app 包，但它认的是「看得出是代码的东西」——
 *  .app / .framework / .dylib / .node / Contents/MacOS 下的可执行文件。而 node-pty 的
 *  `prebuilds/darwin-<arch>/spawn-helper` **没有后缀、躺在 Resources 里**，正好落在它的盲区。
 *
 * ★★★漏掉它的后果是本项目最经典的那种假绿：**公证照样通过**（苹果只检查它认出来的代码），
 *  包也能装、能打开 —— 但**终端一开就挂**，因为 node-pty 拉不起一个没签名的 helper。
 *  构建全绿、公证全绿、用户那边终端是坏的。所以这里显式签，afterSign 再显式验一遍。
 */
function signBinary(path, identity, opts = {}) {
  execFileSync('codesign', [
    '--force',
    '--timestamp',                    // 公证要求可信时间戳
    '--options', 'runtime',           // hardened runtime —— 少了这个公证直接判 Invalid
    '--entitlements', opts.entitlements ?? ENTITLEMENTS,
    '--sign', identity,
    path,
  ], { stdio: 'inherit' })
}

/**
 * `codesign -dv` 的输出。★它**写在 stderr 上**（成功时也是），所以必须用 spawnSync 合并两路取 ——
 * 用 execFileSync 只会拿到空的 stdout，于是每个文件都"看起来没签名"，把验收变成一场误报。
 * 没签名的文件 codesign 会非 0 退出并在 stderr 说 `code object is not signed at all`，一样收得到。
 */
function describeSignature(path) {
  const r = spawnSync('codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8' })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

/**
 * 签完之后的**验收闸门**：包里每一个 Mach-O 都必须(1)已签名(2)是我们的证书签的(3)开了 hardened runtime。
 * 任何一条不满足就**让构建挂掉** —— 宁可现在红，也不要发一个「装得上但终端是坏的」包出去。
 *
 * 只扫 Contents/Resources：Frameworks 下是 Electron 自己那套，electron-builder 处理得很可靠，
 * 而我们真正的风险（asar:false 摊开的 node_modules 原生模块）全在 Resources 里。
 */
function verifyBundleSignatures(appPath, identity, log = console.log) {
  // 先让 codesign 自己查一遍整包的封印（资源被改过 / 嵌套 bundle 没签，这里会炸）。
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' })

  const resources = join(appPath, 'Contents', 'Resources')
  const machO = machOFilesUnder(resources)
  log(`[mac-sign] 扫描 Contents/Resources：${machO.length} 个 Mach-O 文件`)

  const bad = []
  for (const f of machO) {
    const desc = describeSignature(f)
    const signed = desc.includes('Authority=')
    const ours = desc.includes(`Authority=${identity}`) || desc.includes('Authority=Developer ID Application')
    const hardened = /flags=0x[0-9a-f]*\(.*runtime.*\)/.test(desc)
    if (!signed || !ours || !hardened) {
      bad.push(`${f.slice(appPath.length + 1)}  [签名:${signed ? '有' : '无'} 证书:${ours ? '对' : '不对'} runtime:${hardened ? '开' : '关'}]`)
    }
  }
  if (bad.length) {
    throw new Error(
      `[mac-sign] ${bad.length} 个原生二进制没被正确签名，公证会过但运行时会挂：\n  ` + bad.join('\n  ') +
      '\n  （spawn-helper 这类「没后缀的可执行文件」是 electron-builder 的已知盲区，' +
      '应该在 afterPack 里补签 —— 见 scripts/afterPack.cjs）',
    )
  }
  log(`[mac-sign] ✓ 全部 ${machO.length} 个 Mach-O 都已签名 + hardened runtime`)
}

/**
 * 提交公证并装订（staple）。
 *
 * ★装订很重要：票据钉进包里之后，用户**断网也能通过** Gatekeeper。不装订的话每次首次打开都要
 *  联网去问苹果，国内网络下可能卡很久甚至超时，表现出来就是「双击半天没反应」。
 *
 * @param {{target:string, profile:string, kind:'app'|'dmg', log?:Function}} opts
 */
function notarizeAndStaple({ target, profile, kind, log = console.log }) {
  // notarytool 只收 zip / dmg / pkg。.app 要先打包成 zip（ditto 才能保留符号链接和权限位，
  // 用 `zip` 会把 Electron 框架里的软链压平，公证直接判 Invalid）。
  let submitPath = target
  let tmp = null
  if (kind === 'app') {
    tmp = mkdtempSync(join(tmpdir(), 'forge-notarize-'))
    submitPath = join(tmp, `${basename(target)}.zip`)
    log(`[notarize] 打包 ${basename(target)} → zip…`)
    execFileSync('ditto', ['-c', '-k', '--keepParent', target, submitPath], { stdio: 'inherit' })
  }

  try {
    log(`[notarize] 提交 ${basename(submitPath)} 给苹果（要传完整包，慢是正常的）…`)
    // ★用 spawnSync 并**把 stderr 收进来**:execFileSync 抛出的 Error 里只有一句
    //  「Command failed: xcrun notarytool …」,真正的原因(2026-09-15 实测是
    //  `No Keychain password item found for profile`)全在 stderr 上,于是排查时只能去翻构建日志。
    //  错误信息里不带原因,等于把一次明确的失败变成一次要考古的失败。
    const r = spawnSync('xcrun', ['notarytool', 'submit', submitPath, '--keychain-profile', profile, '--wait'],
      { encoding: 'utf8' })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    process.stdout.write(out)
    if (r.status !== 0) {
      throw new Error(`[notarize] notarytool 提交失败(退出码 ${r.status})：\n${out.trim()}`)
    }

    // ★ `--wait` 在「审核完成但结论是 Invalid」时也可能是 0 退出码。只认 Accepted，别看退出码 ——
    //   这正是「命令成功了所以以为没事」的那类假绿。
    if (!/status:\s*Accepted/i.test(out)) {
      const id = (out.match(/id:\s*([0-9a-f-]{36})/i) || [])[1]
      throw new Error(
        '[notarize] 苹果没有接受这个包。查具体原因：\n' +
        `  xcrun notarytool log ${id ?? '<submission-id>'} --keychain-profile ${profile}`,
      )
    }

    log(`[notarize] 装订票据到 ${basename(target)}…`)
    execFileSync('xcrun', ['stapler', 'staple', target], { stdio: 'inherit' })
    execFileSync('xcrun', ['stapler', 'validate', target], { stdio: 'inherit' })
    log(`[notarize] ✓ ${basename(target)} 已公证并装订`)
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * 最终验收：用 Gatekeeper **自己**来判，而不是相信前面每一步都没出错。
 * 这是唯一一个能回答「用户双击会不会被拦」的检查。
 */
function assertGatekeeperAccepts(appPath, log = console.log) {
  // ★用 spawnSync 不用 execFileSync：spctl 把结论**写在 stderr 上**，而 execFileSync 成功时只把
  //  stdout 还给你 —— 拿不到那句 `source=Notarized Developer ID`，也就没法把证据留进构建日志。
  const r = spawnSync('spctl', ['-a', '-vvv', '-t', 'exec', appPath], { encoding: 'utf8' })
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  if (r.status !== 0) {
    throw new Error(`[mac-sign] Gatekeeper 拒绝了这个包 —— 用户双击时会被拦。spctl 原话：\n  ${text || r.error}`)
  }
  log(`[mac-sign] ✓ Gatekeeper: ${text.replace(/\n/g, ' | ') || 'accepted'}`)
}

module.exports = {
  ENTITLEMENTS,
  signingPlan,
  isMachO,
  machOFilesUnder,
  signBinary,
  describeSignature,
  verifyBundleSignatures,
  notarizeAndStaple,
  assertGatekeeperAccepts,
}
