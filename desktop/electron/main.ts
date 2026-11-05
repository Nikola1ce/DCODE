// Electron 主入口：单实例安全窗口、原生目录授权与内核生命周期，配置仅返回白名单展示字段。
// 制作人：Moriarty_Dox
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeImage, nativeTheme, Notification, powerSaveBlocker, Tray } from 'electron'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentConnection } from './agentConnection.js'
import { resolveCoreEntry } from './corePath.js'
import { DesktopController } from './desktopController.js'
import { installIpcRoutes } from './ipc.js'
import { WorkspaceAuthority } from './workspaceAccess.js'
import { CHANNELS } from '../shared/channels.js'
import type { DesktopEvent } from '../shared/api.js'
import { getConfigDir } from '../../src/config.js'
import { DesktopServices } from './services/index.js'
import { DEFAULT_PREFERENCES, SettingsService } from './services/settings.js'
import { DesktopLifecycle } from './desktopLifecycle.js'
import {
  CONTENT_SECURITY_POLICY, SECURE_WEB_PREFERENCES, isAllowedAssetUrl, isTrustedInvocation, isClipboardWriteAllowed,
} from './windowSecurity.js'

let mainWindow: BrowserWindow | null = null
let controller: DesktopController | null = null
let services: DesktopServices | null = null
let shuttingDown = false
let tray: Tray | null = null
let lifecycle: DesktopLifecycle | null = null
const notifications = new Set<Notification>()
const rendererFile = join(__dirname, '../renderer/index.html')
const rendererUrl = pathToFileURL(rendererFile).toString()

function showWindow() {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
}

function createTrayIcon() {
  // 32 像素品牌字母图标，使用原生位图确保 Windows 托盘可直接加载。
  const bitmap = Buffer.alloc(32 * 32 * 4)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const letter = (x >= 9 && x <= 12 && y >= 7 && y <= 24)
      || (x >= 12 && x <= 20 && (y >= 7 && y <= 10 || y >= 21 && y <= 24))
      || (x >= 20 && x <= 23 && y >= 10 && y <= 21)
    const offset = (y * 32 + x) * 4
    bitmap[offset] = letter ? 255 : 130
    bitmap[offset + 1] = letter ? 255 : 77
    bitmap[offset + 2] = letter ? 255 : 35
    bitmap[offset + 3] = 255
  }
  return nativeImage.createFromBitmap(bitmap, { width: 32, height: 32 })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })

  app.on('before-quit', (event) => {
    if (shuttingDown || !controller) return
    event.preventDefault()
    shuttingDown = true
    lifecycle?.dispose()
    for (const notification of notifications) notification.close()
    tray?.destroy()
    tray = null
    void controller.dispose().finally(() => services?.dispose()).catch(() => {}).finally(() => app.quit())
  })
  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.dcode.desktop')
    const authority = new WorkspaceAuthority()
    const settings = new SettingsService(getConfigDir())
    let preferences = await settings.get().catch(() => DEFAULT_PREFERENCES)
    controller = new DesktopController({
      authority,
      rememberWorkspace: (cwd) => settings.rememberWorkspace(cwd),
      chooseDirectory: async (defaultPath) => {
        if (!mainWindow || mainWindow.isDestroyed()) return null
        const choice = await dialog.showOpenDialog(mainWindow, {
          title: '选择 DCODE 项目文件夹', properties: ['openDirectory'], buttonLabel: '授权并连接项目', defaultPath,
        })
        return choice.canceled ? null : choice.filePaths[0] ?? null
      },
      createConnection: async (grant, resumeId) => new AgentConnection({
        resumeId,
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
    const publish = (event: DesktopEvent) => {
      const contents = mainWindow?.webContents
      if (contents && !contents.isDestroyed() && contents.mainFrame.url === rendererUrl) {
        contents.send(CHANNELS.event, event)
      }
    }
    services = new DesktopServices(controller, settings, {
      confirm: async (title, detail) => {
        if (!mainWindow || mainWindow.isDestroyed()) return false
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning', title, message: title, detail,
          buttons: ['取消', '确认'], defaultId: 0, cancelId: 0, noLink: true,
        })
        return result.response === 1
      },
      trash: (path) => shell.trashItem(path),
    }, publish)
    installIpcRoutes(ipcMain, controller, (event) =>
      !shuttingDown && isTrustedInvocation(event, mainWindow?.webContents ?? null, rendererUrl), services)
    controller.subscribe(publish)

    nativeTheme.themeSource = preferences.theme
    mainWindow = new BrowserWindow({
      title: 'DCODE Desktop', width: 1200, height: 820, minWidth: 780, minHeight: 600,
      show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171d' : '#fcfcfe', autoHideMenuBar: true,
      ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: nativeTheme.shouldUseDarkColors ? '#111318' : '#f3f4f8', symbolColor: nativeTheme.shouldUseDarkColors ? '#969faf' : '#636d80', height: 48 } } : {}),
      webPreferences: {
        ...SECURE_WEB_PREFERENCES,
        preload: join(__dirname, 'preload.cjs'),
        partition: 'persist:dcode-desktop',
      },
    })
    tray = new Tray(createTrayIcon())
    tray.setToolTip('DCODE Desktop')
    tray.on('double-click', showWindow)
    tray.on('click', showWindow)
    lifecycle = new DesktopLifecycle(preferences, {
      focused: () => !!mainWindow?.isFocused(),
      startPowerBlocker: () => powerSaveBlocker.start('prevent-app-suspension'),
      stopPowerBlocker: (id) => powerSaveBlocker.stop(id),
      notify: (title, body) => {
        mainWindow?.flashFrame(true)
        if (!Notification.isSupported()) return
        const notification = new Notification({ title, body, silent: false })
        notifications.add(notification)
        notification.on('click', showWindow)
        notification.on('close', () => notifications.delete(notification))
        notification.on('failed', () => notifications.delete(notification))
        notification.show()
      },
      status: (phase) => {
        if (!tray || tray.isDestroyed()) return
        const running = phase === 'running' || phase === 'cancelling'
        tray.setToolTip(`DCODE Desktop · ${running ? '任务执行中' : '就绪'}`)
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: `运行中会话 ${running ? 1 : 0}`, enabled: false },
          { label: '显示窗口', click: showWindow },
          { label: '停止当前回合', enabled: phase === 'running', click: () => { void controller?.cancelTurn().catch(() => {}) } },
          { type: 'separator' }, { label: '退出 DCODE', click: () => app.quit() },
        ]))
      },
    })
    lifecycle.handle({ type: 'connection', snapshot: controller.getSnapshot() })
    controller.subscribe((event) => lifecycle?.handle(event))
    const syncChrome = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const dark = nativeTheme.shouldUseDarkColors
      mainWindow.setBackgroundColor(dark ? '#15171d' : '#fcfcfe')
      if (process.platform === 'win32') mainWindow.setTitleBarOverlay({ color: dark ? '#111318' : '#f3f4f8', symbolColor: dark ? '#969faf' : '#636d80', height: 48 })
    }
    nativeTheme.on('updated', syncChrome)
    settings.subscribe((value) => { preferences = value; lifecycle?.update(value); nativeTheme.themeSource = value.theme; syncChrome() })
    let decidingClose = false
    mainWindow.on('close', (event) => {
      if (shuttingDown) return
      event.preventDefault()
      if (preferences.closeBehavior === 'tray') { mainWindow?.hide(); return }
      if (preferences.closeBehavior === 'quit') { app.quit(); return }
      if (decidingClose || !mainWindow) return
      decidingClose = true
      void dialog.showMessageBox(mainWindow, { type: 'question', title: '关闭 DCODE 窗口',
        message: '关闭窗口后如何处理？', detail: '最小化到托盘后，当前任务将继续运行。',
        buttons: ['最小化到托盘', '退出应用', '取消'], defaultId: 0, cancelId: 2, checkboxLabel: '记住我的选择' }).then(async (choice) => {
          if (choice.response === 2) return
          if (choice.checkboxChecked) await settings.update({ closeBehavior: choice.response === 0 ? 'tray' : 'quit' })
          if (choice.response === 0) mainWindow?.hide()
          else app.quit()
        }).catch(() => {}).finally(() => { decidingClose = false })
    })
    const contents = mainWindow.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-frame-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.session.setPermissionRequestHandler((requester, permission, callback) => callback(isClipboardWriteAllowed(permission, requester, contents, rendererUrl)))
    contents.session.setPermissionCheckHandler((requester, permission) => isClipboardWriteAllowed(permission, requester, contents, rendererUrl))
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
    mainWindow.on('focus', () => mainWindow?.flashFrame(false))
    mainWindow.on('closed', () => { mainWindow = null })
    return mainWindow.loadFile(rendererFile)
  }).catch(() => {
    dialog.showErrorBox('DCODE Desktop 启动失败', '请确认桌面工程已构建且 Electron 安装完整。未输出包含环境或配置的错误详情。')
    app.quit()
  })
}
