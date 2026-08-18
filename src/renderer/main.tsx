import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installAutoHideScrollbars } from './shell/autoHideScrollbars'

// 滚动条自动隐藏的「滚动停止后隐藏」那一半(另一半是 global.css 的 :hover)。装在这里而不是某个组件里:
// 一个 document 捕获监听就覆盖全部滚动容器,不需要每个面板各自接一遍,新增面板也不用记得来登记。
installAutoHideScrollbars()

createRoot(document.getElementById('root')!).render(<App />)
