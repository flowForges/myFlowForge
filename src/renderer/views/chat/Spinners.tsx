/**
 * 两个转圈图标。**只此一份** —— 主代理和子代理各一个,别处要转圈也从这儿取。
 *
 * ★★为什么不是一个通用 spinner:用户要的是「子 agent 跟主代理思考**区分开**」。
 *  同一个图标换个颜色是分不开的 —— 颜色在小尺寸、在不同皮肤下都不可靠,而且色弱的人看不出来。
 *  所以两者**形状不同**:主代理是**放射线条**,子代理是**绕圈的圆点**。
 *  线条 vs 圆点这个差别在 14px 下也成立,不依赖颜色。
 *
 * ★★原来两处都是一段**开口圆弧**整体旋转。用户否掉了(「我甚至所有的开口圆弧都去掉」)——
 *  而且子代理那处更糟:转的是一枚**放大镜**,有手柄的图形绕中心转会甩圈,读起来是乱晃不是在转。
 *
 * ★动画都用 `opacity` 的错相渐变,不用 `transform: rotate`:
 *  绕中心转的图形在低分屏上边缘会抖(子像素采样),而逐段亮灭没有这个问题,
 *  也正是系统 loading 指示器的做法。
 */

/** 主代理在思考:12 根放射线条逐段亮灭。★这是用户指定的那种样式。 */
export function ThinkSpinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="sp-spokes" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <line
          key={i}
          x1="12" y1="3.6" x2="12" y2="7.4"
          transform={`rotate(${i * 30} 12 12)`}
          style={{ animationDelay: `${(i * 0.9) / 12}s` }}
        />
      ))}
    </svg>
  )
}

/** 子代理在跑:三颗圆点绕圈。★和主代理**形状不同**,不是换个颜色。 */
export function SubagentSpinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="sp-orbit" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {Array.from({ length: 3 }, (_, i) => (
        <circle
          key={i}
          cx="12" cy="4.6" r="2.2"
          transform={`rotate(${i * 120} 12 12)`}
          style={{ animationDelay: `${(i * 0.9) / 3}s` }}
        />
      ))}
    </svg>
  )
}
