// 最小日志接口;worker 提供文件实现,默认什么都不写
export interface Logger {
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} }
