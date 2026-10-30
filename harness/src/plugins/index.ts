import type { Plugin } from '../kernel/pluginHost'
import loopDirect from './loop-direct'
import loopEcho from './loop-echo'
import modelAnthropic from './model-anthropic'
import modelChatgpt from './model-chatgpt'
import modelOpenai from './model-openai'
import modelsRegistry from './models-registry'

// 本期静态登记的内置插件;顺序:models-registry → 协议适配器 → loop-direct → loop-echo
export const BUILTIN_PLUGINS: Plugin[] = [modelsRegistry, modelOpenai, modelAnthropic, modelChatgpt, loopDirect, loopEcho]
