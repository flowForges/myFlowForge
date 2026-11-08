// 库打不开和插件没起来,界面都算 不支持(spec §4.3:"插件没起来是 -32601,库打不开是 -32603 memory is
// unavailable,界面两者都显示 不支持")。那条规矩写在 session.delete 旁边,但原理不止它一个:memory-default
// 的读方法统一经 rpc.ts 的 register() 包一层,store 没开时都答同一句 -32603 'memory is unavailable',
// 跟方法压根没注册的 -32601 是同一类"这页现在用不了",这个页面的每个 memory.* 调用都按这条认。
import { isUnsupported, toCallError } from '../rpc'

const ERR_INTERNAL = -32603
const MESSAGE = 'memory is unavailable'

export function memoryUnsupported(e: unknown): boolean {
  if (isUnsupported(e)) return true
  const c = toCallError(e)
  return c.code === ERR_INTERNAL && c.message === MESSAGE
}
