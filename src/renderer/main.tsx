import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PathPickerProvider } from './state/PathPicker'
import { installAutoHideScrollbars } from './shell/autoHideScrollbars'
import { installDropGuard } from './shell/dropGuard'

// 滚动条自动隐藏的「滚动停止后隐藏」那一半(另一半是 global.css 的 :hover)。装在这里而不是某个组件里:
// 一个 document 捕获监听就覆盖全部滚动容器,不需要每个面板各自接一遍,新增面板也不用记得来登记。
installAutoHideScrollbars()

// 拖文件进窗口的兜底。★Electron 的默认行为是把整个窗口导航到那个 file:// 地址 —— 拖歪一次就是白屏,
// 而且没有地址栏能退回来。输入框只占屏幕一小条,「拖拽附件」上线之后拖偏是常态,所以这层必须有。
installDropGuard()

// PathPickerProvider 包在最外层:「选一个路径」这件事在本机是系统对话框、连着远程主机时是
// 服务端目录浏览器(那台机器的目录,本机对话框里根本没有)。包在根上,任何深处的组件都能直接用。
createRoot(document.getElementById('root')!).render(
  <PathPickerProvider>
    <App />
  </PathPickerProvider>,
)
