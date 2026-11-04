// 沙箱 preload：构建为自包含 CJS，只允许 Electron contextBridge 白名单 API。
// 制作人：Moriarty_Dox
import { contextBridge, ipcRenderer } from 'electron'
import { createDesktopBridge } from './bridge.js'

contextBridge.exposeInMainWorld('dcode', createDesktopBridge(ipcRenderer))
