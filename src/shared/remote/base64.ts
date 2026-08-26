// ── base64 / UTF-8:自己实现,不用 Buffer / btoa / TextEncoder ─────────────────
// ★这几个函数要在 **Electron 主进程 / React Native(Hermes)/ Cloudflare Worker** 三种运行时里跑。
//  `Buffer` 只有 Node 有,`btoa` Hermes 上不保证有,`TextEncoder` 也不保证。
//  纯算术实现没有任何平台依赖 —— 不值得为了省 20 行去赌某个全局对象存在。
//
// ★为什么单独一份文件、而不是继续待在 `e2e.ts` 里:`e2e.ts` 第一行是 `import nacl from 'tweetnacl'`,
//  而 `tweetnacl` **不在** `mobile/package.json` 的依赖里。手机端只想要这几个编解码函数,
//  从 `e2e.ts` 拿就会把一整个加密库拖进 bundle(而且根本装不上)。所以编解码单独一份**零依赖**的,
//  `e2e.ts` 从这里 re-export —— 它原有的调用方和测试一个字都不用改。

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? B64[b2 & 63] : '='
  }
  return out
}

export function fromBase64(s: string): Uint8Array | null {
  const clean = s.replace(/=+$/, '')
  // ★非法字符必须让整个解码失败,不能悄悄跳过。对面发来的任何垃圾都该在这里被挡住,
  //  而不是解出一段「差不多」的字节再拿去当密文。
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) return null
  if (clean.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let p = 0
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i])
    const c1 = B64.indexOf(clean[i + 1] ?? 'A')
    const c2 = B64.indexOf(clean[i + 2] ?? 'A')
    const c3 = B64.indexOf(clean[i + 3] ?? 'A')
    out[p++] = (c0 << 2) | (c1 >> 4)
    if (i + 2 < clean.length) out[p++] = ((c1 & 15) << 4) | (c2 >> 2)
    if (i + 3 < clean.length) out[p++] = ((c2 & 3) << 6) | c3
  }
  return out.subarray(0, p)
}

/** UTF-8 编解码,同样不依赖 TextEncoder/TextDecoder(Hermes 上不保证有)。 */
export function utf8ToBytes(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00)
        i++
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
        continue
      }
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

export function bytesToUtf8(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; ) {
    const c = b[i]
    if (c < 0x80) {
      out += String.fromCharCode(c)
      i += 1
    } else if (c < 0xe0) {
      out += String.fromCharCode(((c & 31) << 6) | (b[i + 1] & 63))
      i += 2
    } else if (c < 0xf0) {
      out += String.fromCharCode(((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63))
      i += 3
    } else {
      const cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63)
      const v = cp - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 1023))
      i += 4
    }
  }
  return out
}
