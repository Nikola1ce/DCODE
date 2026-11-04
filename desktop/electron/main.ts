// Electron 主入口：单实例安全窗口、原生目录授权与内核生命周期；不向 renderer 暴露配置。
// 制作人：Moriarty_Dox
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentConnection } from './agentConnection.js'
import { resolveCoreEntry } from './corePath.js'
import { DesktopController } from './desktopController.js'
import { installIpcRoutes } from './ipc.js'
import { WorkspaceAuthority } from './workspaceAccess.js'
import { CHANNELS } from '../shared/channels.js'
import {
  CONTENT_SECURITY_POLICY, SECURE_WEB_PREFERENCES, isAllowedAssetUrl, isTrustedInvocation,
} from './windowSecurity.js'

let mainWindow: BrowserWindow | null = null
let controller: DesktopController | null = null
let shuttingDown = false
const rendererFile = join(__dirname, '../renderer/index.html')
const rendererUrl = pathToFileURL(rendererFile).toString()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
  })

  app.on('before-quit', (event) => {
    if (shuttingDown || !controller) return
    event.preventDefault()
    shuttingDown = true
    void controller.dispose().catch(() => {}).finally(() => app.quit())
  })
  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(() => {
    const authority = new WorkspaceAuthority()
    controller = new DesktopController({
      authority,
      chooseDirectory: async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return null
        const choice = await dialog.showOpenDialog(mainWindow, {
          title: '选择 DCODE 项目文件夹', properties: ['openDirectory'], buttonLabel: '授权并连接项目',
        })
        return choice.canceled ? null : choice.filePaths[0] ?? null
      },
      createConnection: async (grant) => new AgentConnection({
        cwd: grant.cwd,
        executable: process.execPath,
        coreEntry: await resolveCoreEntry({
          packaged: app.isPackaged,
          repoRoot: resolve(__dirname, '../../..'),
          resourcesPath: process.resourcesPath,
          env: process.env,
        }),
        validateLaunch: () => authority.validate(grant),
      }),
    })
    installIpcRoutes(ipcMain, controller, (event) =>
      isTrustedInvocation(event, mainWindow?.webContents ?? null, rendererUrl))
    controller.subscribe((event) => {
      const contents = mainWindow?.webContents
      if (contents && !contents.isDestroyed() && contents.mainFrame.url === rendererUrl) {
        contents.send(CHANNELS.event, event)
      }
    })

    mainWindow = new BrowserWindow({
      title: 'DCODE Desktop', width: 1200, height: 820, minWidth: 780, minHeight: 600,
      show: false, backgroundColor: '#0e1118', autoHideMenuBar: true,
      webPreferences: {
        ...SECURE_WEB_PREFERENCES,
        preload: join(__dirname, 'preload.cjs'),
        partition: 'dcode-desktop',
      },
    })
    const contents = mainWindow.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-frame-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    contents.session.setPermissionCheckHandler(() => false)
    const assets = new Set(['index.html', 'index.js', 'index.css']
      .map((name) => pathToFileURL(join(__dirname, '../renderer', name)).toString()))
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isAllowedAssetUrl(details.url, assets) })
    })
    contents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [`${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`],
      } })
    })
    mainWindow.once('ready-to-show', () => mainWindow?.show())
    mainWindow.on('closed', () => { mainWindow = null })
    return mainWindow.loadFile(rendererFile)
  }).catch(() => {
    dialog.showErrorBox('DCODE Desktop 启动失败', '请确认桌面工程已构建且 Electron 安装完整。未输出包含环境或配置的错误详情。')
    app.quit()
  })
}
