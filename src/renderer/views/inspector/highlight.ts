// 这份语法表现在**三端共用**:Electron 的文件预览 / diff(逐行 `highlight`)、对话区的围栏代码块
// (整块 `highlightBlock`),以及手机端的同样两处。它零 import、纯函数,所以搬到 `@shared/highlight`
// 没有任何代价 —— 而两份副本必然漂移,漂移的表现是「同一段代码在电脑和手机上关键字不一样多」。
// 同一个路子:@shared/chat/unread、@shared/chat/largePaste。
// 这里保留一层 re-export,免得改动 blocks.tsx / FilePreview.tsx 的 import。
export * from '@shared/highlight'
