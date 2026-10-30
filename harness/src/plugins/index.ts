import type { Plugin } from '../kernel/pluginHost'
import loopDirect from './loop-direct'
import loopEcho from './loop-echo'
import modelAnthropic from './model-anthropic'
import modelChatgpt from './model-chatgpt'
import modelOpenai from './model-openai'
import modelsRegistry from './models-registry'
import toolsCoding from './tools-coding'
import toolsRegistry from './tools-registry'

// 本期静态登记的内置插件;顺序:models-registry → 协议适配器 → tools-registry → tools-coding → loop-direct → loop-echo
export const BUILTIN_PLUGINS: Plugin[] = [modelsRegistry, modelOpenai, modelAnthropic, modelChatgpt, toolsRegistry, toolsCoding, loopDirect, loopEcho]
