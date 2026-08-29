import * as Crypto from 'expo-crypto'
import nacl from 'tweetnacl'

/**
 * 给 tweetnacl 接上一个**真的**随机数源。
 *
 * ## ★★为什么必须做这件事
 *
 * React Native **没有** `crypto.getRandomValues`(Hermes 没有,Expo 的 winter 运行时也没有)。
 * 而 tweetnacl 在拿不到它的时候,`randombytes` 是这么写的:
 *
 * ```js
 * var randombytes = function() { throw new Error('no PRNG'); };
 * ```
 *
 * 也就是说:**不接这一层,手机端第一次握手就当场抛异常**。抛出来还算好的 ——
 * 真正危险的是有人为了"先跑通"随手 `nacl.setPRNG` 塞一个 `Math.random()` 进去。
 * 那样整条链路会**看起来完全正常**:握手成功、消息收发、界面一切正常,
 * 而一次性密钥是可预测的,端到端加密从此只是个装饰。
 *
 * ★★所以这个文件只有一个合法实现:操作系统的 CSPRNG。
 *  `expo-crypto` 的 `getRandomValues` 在 iOS 上是 `SecRandomCopyBytes`,
 *  在 Android 上是 `SecureRandom`。**不许有回退分支** —— 拿不到就抛,让它当场坏掉,
 *  而不是悄悄降级成一个假的安全。
 *
 * ## 什么时候调
 *
 * `app/_layout.tsx` 顶上调一次。★必须在任何一次握手之前 —— tweetnacl 是在**调用时**
 * 才去要随机数的,所以晚接也来得及,但"来得及"依赖于调用顺序,而调用顺序会变。
 * 放在根布局里是唯一不会被绕过的地方。
 */

let installed = false

export function installPRNG(): void {
  if (installed) return
  nacl.setPRNG((x, n) => {
    // ★★`getRandomValues` 是**就地填充**的,而 tweetnacl 要的正是就地填充 `x` 的前 n 个字节。
    //  `x` 可能比 n 长(tweetnacl 会传一个更大的缓冲进来),所以必须切出前 n 个 ——
    //  填满整个 x 不会出错,但填**不满** n 会留下一段零字节,而那正好是密钥的一部分。
    const view = x.length === n ? x : x.subarray(0, n)
    Crypto.getRandomValues(view)
  })
  installed = true
}

/**
 * 随机数源到底通不通。★给「一按连接就炸」之外的一条更早的退路 ——
 * 设置里可以拿它显示一句人话,而不是让用户在握手那一刻撞上一个英文异常。
 */
export function prngWorks(): boolean {
  try {
    const a = new Uint8Array(32)
    const b = new Uint8Array(32)
    Crypto.getRandomValues(a)
    Crypto.getRandomValues(b)
    // 两次全等基本不可能(2^-256),全零则说明拿到的是个空实现。
    return a.some((v) => v !== 0) && a.some((v, i) => v !== b[i])
  } catch {
    return false
  }
}
