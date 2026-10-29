import type { Plugin } from '../kernel/pluginHost'
import loopEcho from './loop-echo'

// 本期静态登记的内置插件
export const BUILTIN_PLUGINS: Plugin[] = [loopEcho]
