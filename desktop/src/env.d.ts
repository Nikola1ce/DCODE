// 浏览器可见 API 声明；没有 Node/Electron/配置接口。
// 制作人：Moriarty_Dox
import type { DesktopApi } from '../shared/api.js'

declare global {
  interface Window {
    readonly dcode: DesktopApi
  }
}
