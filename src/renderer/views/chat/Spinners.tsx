/**
 * 两个「在动」的图标。**只此一份** —— 主代理和子代理各一个,别处要用也从这儿取。
 *
 * ★★为什么不是一个通用 spinner:用户要的是「子 agent 跟主代理思考**区分开**」。
 *  同一个图标换个颜色是分不开的(小尺寸、换皮肤、色弱三种情况下都不成立),所以判据是
 *  **画的东西不同**:主代理是一张**散开的节点网**,子代理是**同心的波纹**。
 *
 * ★★★2026-09-18 第三轮定稿。此前两版都被否掉,原因值得记下来:
 *  ① 开口圆弧整体旋转 —— 「所有的开口圆弧都去掉」;
 *  ② 12 根放射线条逐段亮灭 —— **那是 macOS 系统菊花的形状**,用户看到的是「网络中断、
 *     加载不出来」。问题不在做得好不好,在于这个形状已经被系统占用了。
 *  所以这一版刻意不做任何「绕着圈追尾」的东西。
 *
 * ★主代理 = 思维导图式的两级生长 + **1→2→3→2 的传递**(见下面的八拍)。
 *  子代理 = 从中心往外推的波纹 —— 「派出去的活儿正在外面跑」。
 */

/* ── 主代理:一张两级的思维导图 ─────────────────────────────────────────
 * 中心一个点,长出四个,四个各自再长出两个(共 12 个节点、三层)。
 * ★坐标一律按角度算,不手写:八个方向手算必错一两个,而错位在 16px 下看不出来,
 *  放大了才发现 —— 那时候图标早就发出去了。
 */
const HUB_R = 2.4
const D1 = 6.3, R1 = 1.5          // 一级:离中心多远、点多大
const D2 = 4.9, R2 = 1.15         // 二级:离**它爹**多远、点多大
const SPREAD = 42                  // 二级相对父枝的张角

type Pt = readonly [number, number]
const pol = (cx: number, cy: number, angDeg: number, d: number): Pt => {
  const a = (angDeg * Math.PI) / 180
  return [cx + Math.cos(a) * d, cy + Math.sin(a) * d]
}
const f = (n: number) => Number(n.toFixed(2))

const TREE = [-90, 0, 90, 180].map((ang) => {
  const p = pol(12, 12, ang, D1)
  return {
    ang,
    p,
    s: pol(12, 12, ang, HUB_R + 0.45),
    e: pol(12, 12, ang, D1 - R1 - 0.3),
    kids: [-SPREAD, SPREAD].map((off) => ({
      s: pol(p[0], p[1], ang + off, R1 + 0.4),
      e: pol(p[0], p[1], ang + off, D2 - R2 - 0.25),
      p: pol(p[0], p[1], ang + off, D2),
    })),
  }
})

const Line = ({ a, b, cls }: { a: Pt; b: Pt; cls: string }) => (
  <line className={cls} x1={f(a[0])} y1={f(a[1])} x2={f(b[0])} y2={f(b[1])} />
)
const Dot = ({ p, r }: { p: Pt; r: number }) => <circle cx={f(p[0])} cy={f(p[1])} r={r} />

/**
 * 主代理在思考:**1 → 2 → 3 → 2** 的逐层传递,连线也各算一拍(共八拍),整张图 4.2 秒转一圈。
 *
 * ★★同一时刻只有一组是亮的,其余压到一成 —— 用户 2026-09-18 原话:「1 亮的时候 2 和 3 不亮,
 *  然后 2 亮 1 灭」。这件事**做不成「一条动画 + 不同 delay」**:一级在一个周期里要亮两次
 *  (去程和回程各一次),延迟错开只能做出单向的波。所以五组各有各的关键帧(见 chat.css 的 sp-p0..p4)。
 *
 * ★默认 16px:那一行的文字是 10.5px×1.5(行高约 15.75px),16 是**不撑高这一行**的上限。
 *  再往下 13px 时,二级连线只有 0.6 CSS px —— 在 1× 屏上不到一个物理像素,渲染出来是灰雾不是线。
 */
export function ThinkSpinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="sp-mind" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <g className="sp-rot">
        {/* 拍 4 / 6:二级连线 */}
        <g className="sp-b3">
          {TREE.map((b, i) => b.kids.map((k, j) => <Line key={`${i}-${j}`} a={k.s} b={k.e} cls="l2" />))}
        </g>
        {/* 拍 5:二级节点(最外圈,传递的终点) */}
        <g className="sp-b4">
          {TREE.map((b, i) => b.kids.map((k, j) => <Dot key={`${i}-${j}`} p={k.p} r={R2 + 0.45} />))}
        </g>
        {/* 拍 2 / 8:一级连线 */}
        <g className="sp-b1">{TREE.map((b, i) => <Line key={i} a={b.s} b={b.e} cls="l1" />)}</g>
        {/* 拍 3 / 7:一级节点 */}
        <g className="sp-b2">{TREE.map((b, i) => <Dot key={i} p={b.p} r={R1 + 0.55} />)}</g>
        {/* 拍 1:中心 —— 一切从这里出发,也回到这里 */}
        <g className="sp-b0"><circle className="sp-hub" cx="12" cy="12" r={HUB_R} /></g>
      </g>
    </svg>
  )
}

/**
 * 子代理在跑:中心一颗实点,三圈波纹往外推。
 *
 * ★和主代理**形状不同**:那边是散开的网,这边是**同心**的圈 —— 不靠颜色区分。
 * ★三圈(不是两圈)是为了消掉空档:两圈时会出现「两圈都淡到看不见」的一瞬,那一瞬看着像停了。
 * ★扩散只到 1.3 倍就消失(不是跑到最外面):环越往外越淡,跑满全程的话最亮那一刻也只剩半透明,
 *  于是整枚图标看着比实际更弱 —— 用户 2026-09-18 说「感觉很小啊,怕看不清」,一半是这个原因,
 *  不是尺寸。
 * ★颜色走 `currentColor` —— 子代理卡的 `.sac-ico` 本来就是 `color: var(--accent)`,
 *  所以它**跟着用户选的强调色和壁纸自动配色走**,不自己定死一个色相。
 */
export function SubagentSpinner({ size = 18 }: { size?: number }) {
  return (
    <svg className="sp-ripple" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {[0, 0.53, 1.07].map((d) => (
        <circle key={d} className="ring" cx="12" cy="12" r="7" style={{ animationDelay: `${d}s` }} />
      ))}
      <circle className="core" cx="12" cy="12" r="2.6" />
    </svg>
  )
}
