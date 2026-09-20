// 这份逻辑现在两端共用(手机端的「这段有 N 字 · 转成附件?」用的是同一份)。
// 搬到了 @shared/chat/largePaste;这里保留一层 re-export,免得改动 Composer 的 import。
export * from '@shared/chat/largePaste'
