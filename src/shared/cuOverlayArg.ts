/** 浮窗渲染进程的启动参数:preload 看到它就只暴露 `cuOverlay` 四个方法,不暴露 `window.forge`。
 *  单独一个文件:preload 只引这一行,不把 computerUse.ts(连带 zod)打进 preload。 */
export const CU_OVERLAY_ARG = '--forge-cu-overlay'
