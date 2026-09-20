/**
 * 「窗口现在是不是焦点」→ `<html data-win-focus="on|off">`。
 *
 * ★★为什么要有它:壁纸模糊只在【你正在看这个窗口】的时候才有意义。
 *  你在读字,就把壁纸糊掉,让字锐利;你切走了,没人读字,壁纸就该恢复清晰给你看。
 *  用户 2026-09-08 原话:「cmux 焦点在 app 的时候是那种模糊的,焦点不在 app 的时候背景是清晰的」。
 *
 * ★用 window 的 focus/blur 而不是 document.visibilityState:后者只区分「窗口有没有被最小化/切到别的
 *  桌面」,而这里要的是「有没有被别的 app 盖住焦点」—— 那正是 focus/blur 的语义。
 * ★初值用 document.hasFocus():应用启动时可能本来就不在前台(开机自启、从后台恢复),
 *  只等事件的话第一帧会错。
 */
export function initWindowFocus(): () => void {
  const root = document.documentElement
  const set = (on: boolean) => root.setAttribute('data-win-focus', on ? 'on' : 'off')
  const onFocus = () => set(true)
  const onBlur = () => set(false)
  set(typeof document.hasFocus === 'function' ? document.hasFocus() : true)
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  return () => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onBlur)
  }
}
