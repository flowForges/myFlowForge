/**
 * 对外链接。★域名只写这一处 —— 官网换域名时只改这个文件，不用满仓库找散落的字符串。
 *
 * ★★官网的文档是**单页 + 侧栏锚点**（`docs.html`，不是 /docs/xxx 这种多页路由），所以深链一律是
 *  `docs.html#锚点`。锚点名要和官网 `docs.html` 里的 `id=` 对得上 —— 对不上不会报错，
 *  只会静默落到页面顶部，用户以为「点了没反应 / 这文档里没写」。加新锚点前先去官网确认那个 id 存在。
 *
 * ★★`ff.wzcu.com` 和 `myflowforge.wzcu.com` 指向同一个站点。取后者是因为它是 GitHub 仓库主页上
 *  登记的那一个 —— 对外公开的规范写法应该只有一个，不该在 app 里同时出现两种。
 */
export const SITE_ORIGIN = 'https://myflowforge.wzcu.com'

/**
 * 给人看的域名(按钮上写「打开官网 xxx」用)。★从 SITE_ORIGIN 派生,不许手写 ——
 * 手写的那份换域名时一定会忘,于是按钮上写着一个域名、点开却去了另一个。
 */
export const SITE_HOST = SITE_ORIGIN.replace(/^https?:\/\//, '')

/** 文档页的某一节。不传锚点就是文档首页。 */
export function docsUrl(anchor?: string): string {
  return `${SITE_ORIGIN}/docs.html${anchor ? `#${anchor}` : ''}`
}

/** 怎么配远程主机（连另一台电脑）。对应官网 docs.html 的 `id="remote"`。 */
export const DOCS_REMOTE = docsUrl('remote')
/** 中转（relay）怎么搭、怎么填地址。对应 `id="relay"`。 */
export const DOCS_RELAY = docsUrl('relay')
/** 手机端怎么连。对应 `id="mobile"`。 */
export const DOCS_MOBILE = docsUrl('mobile')
