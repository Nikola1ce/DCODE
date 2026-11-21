// Electron 主入口：单实例安全窗口、原生目录授权与内核生命周期，配置仅返回白名单展示字段。
// 制作人：Moriarty_Dox
import { app, BrowserWindow, dialog, shell, Menu, nativeImage, nativeTheme, Notification, powerSaveBlocker, Tray } from 'electron'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentConnection } from './agentConnection.js'
import { resolveCoreEntry } from './corePath.js'
import { DesktopController } from './desktopController.js'
import { installIpcRoutes } from './ipc.js'
import { DesktopFault } from './errors.js'
import { samePath, WorkspaceAuthority, type WorkspaceGrant } from './workspaceAccess.js'
import { CHANNELS } from '../shared/channels.js'
import type { DesktopEvent } from '../shared/api.js'
import { getConfigDir } from '../../src/config.js'
import { DesktopServices } from './services/index.js'
import { DEFAULT_PREFERENCES, SettingsService } from './services/settings.js'
import { DesktopLifecycle } from './desktopLifecycle.js'
import {
  CONTENT_SECURITY_POLICY, SECURE_WEB_PREFERENCES, isAllowedAssetUrl, isTrustedInvocation, isClipboardWriteAllowed,
} from './windowSecurity.js'

import { ConfigurationService } from './services/configuration.js'

interface Workbench {
  window: BrowserWindow
  controller: DesktopController
  dispose(): Promise<void>
}
const windows = new Map<number, Workbench>()
const grants = new Map<WorkspaceGrant, WorkspaceAuthority>()
const settings = new SettingsService(getConfigDir())
const configuration = new ConfigurationService()
let shuttingDown = false
let tray: Tray | null = null
const notifications = new Set<Notification>()
const rendererFile = join(__dirname, '../renderer/index.html')
const rendererUrl = pathToFileURL(rendererFile).toString()

function showWindow(window = BrowserWindow.getFocusedWindow() ?? windows.values().next().value?.window) {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function refreshTray() {
  if (!tray || shuttingDown) return
  const items = [...windows.values()]
  const running = items.filter(item => ['running', 'cancelling'].includes(item.controller.getSnapshot().phase))
  tray.setToolTip('DCODE Desktop · 运行中会话 ' + running.length)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '运行中会话 ' + running.length, enabled: false },
    ...items.flatMap(({ window, controller }) => {
      const snapshot = controller.getSnapshot()
      const name = snapshot.cwd ? basename(snapshot.cwd) : '工作台'
      return [
        { label: '显示 ' + name, click: () => showWindow(window) },
        ...(snapshot.phase === 'running' ? [{ label: '停止 ' + name + ' 当前回合', click: () => { void controller.cancelTurn().catch(() => {}) } }] : []),
      ]
    }),
    { type: 'separator' }, { label: '退出 DCODE', click: () => app.quit() },
  ]))
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

async function openWorkbench(initialDirectory?: string): Promise<void> {
  let preferences = await settings.get().catch(() => DEFAULT_PREFERENCES)
  if (shuttingDown) throw new Error('桌面正在退出')
  const authority = new WorkspaceAuthority(undefined, grants)
  nativeTheme.themeSource = preferences.theme
  const mainWindow = new BrowserWindow({
    title: 'DCODE Desktop', width: 1200, height: 820, minWidth: 780, minHeight: 600,
    show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171d' : '#fcfcfe', autoHideMenuBar: true,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: nativeTheme.shouldUseDarkColors ? '#111318' : '#f3f4f8', symbolColor: nativeTheme.shouldUseDarkColors ? '#969faf' : '#636d80', height: 48 } } : {}),
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: join(__dirname, 'preload.cjs'),
      partition: 'persist:dcode-desktop',
    },
  })
  const controller = new DesktopController({
    authority,
    rememberWorkspace: (cwd) => settings.rememberWorkspace(cwd),
    chooseDirectory: async (defaultPath) => {
      if (initialDirectory) {
        const directory = initialDirectory
        initialDirectory = undefined
        return directory
      }
      if (mainWindow.isDestroyed()) return null
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
  const services = new DesktopServices(controller, settings, {
    confirm: async (title, detail) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title, message: title, detail,
        buttons: ['取消', '确认'], defaultId: 0, cancelId: 0, noLink: true,
      })
      return result.response === 1
    },
    trash: (path) => shell.trashItem(path),
  }, publish, configuration, {
    directory: join(app.getPath('userData'), 'worktrees'),
    async open(path) {
      const existing = [...windows.values()].find(item => samePath(item.controller.getSnapshot().cwd ?? '', path))
      if (existing) showWindow(existing.window)
      else await openWorkbench(path)
    },
    async withTree(path, removing, operation) {
      const existing = [...windows.values()].find(item => samePath(item.controller.getSnapshot().cwd ?? '', path))
      if (existing) {
        if (removing) throw new DesktopFault('BUSY', '请先关闭工作树窗口，再清理工作目录。')
        return existing.controller.useWorkspace(async grant => {
          if (!samePath(grant.cwd, path)) throw new DesktopFault('WORKSPACE_CHANGED', '工作树窗口已切换项目。')
          return operation()
        }, true)
      }
      const lease = new WorkspaceAuthority(undefined, grants)
      await lease.authorizeDialogSelection(path)
      try { return await operation() } finally { lease.clear() }
    },
  })
  const removeRoutes = installIpcRoutes(mainWindow.webContents.ipc, controller, (event) =>
    !shuttingDown && isTrustedInvocation(event, mainWindow?.webContents ?? null, rendererUrl), services)
  controller.subscribe(publish)

  const lifecycle = new DesktopLifecycle(preferences, {
    focused: () => !!mainWindow?.isFocused(),
    startPowerBlocker: () => powerSaveBlocker.start('prevent-app-suspension'),
    stopPowerBlocker: (id) => powerSaveBlocker.stop(id),
    notify: (title, body) => {
      mainWindow?.flashFrame(true)
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body, silent: false })
      notifications.add(notification)
      notification.on('click', () => showWindow(mainWindow))
      notification.on('close', () => notifications.delete(notification))
      notification.on('failed', () => notifications.delete(notification))
      notification.show()
    },
    status: refreshTray,
  })
  controller.subscribe(event => lifecycle.handle(event))
  const syncChrome = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const dark = nativeTheme.shouldUseDarkColors
    mainWindow.setBackgroundColor(dark ? '#15171d' : '#fcfcfe')
    if (process.platform === 'win32') mainWindow.setTitleBarOverlay({ color: dark ? '#111318' : '#f3f4f8', symbolColor: dark ? '#969faf' : '#636d80', height: 48 })
  }
  nativeTheme.on('updated', syncChrome)
  const unsubscribeSettings = settings.subscribe((value) => { preferences = value; publish({ type: 'preferences', value }); lifecycle.update(value); nativeTheme.themeSource = value.theme; syncChrome() })
  let decidingClose = false
  mainWindow.on('close', (event) => {
    if (shuttingDown) return
    if (windows.size > 1) {
      if (!['running', 'cancelling'].includes(controller.getSnapshot().phase)) return
      event.preventDefault()
      if (decidingClose) return
      decidingClose = true
      void dialog.showMessageBox(mainWindow, { type: 'question', message: '停止此窗口的任务并关闭？', buttons: ['继续工作', '停止并关闭'], cancelId: 0 }).then(choice => {
        if (choice.response === 1) mainWindow.destroy()
      }).finally(() => { decidingClose = false })
      return
    }
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
  const clipboardAllowed = (permission: string, requester: Electron.WebContents | null) =>
    !!requester && [...windows.values()].some(item => !item.window.isDestroyed() && isClipboardWriteAllowed(permission, requester, item.window.webContents, rendererUrl))
  contents.session.setPermissionRequestHandler((requester, permission, callback) => callback(clipboardAllowed(permission, requester)))
  contents.session.setPermissionCheckHandler((requester, permission) => clipboardAllowed(permission, requester))
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
  let cleanup: Promise<void> | undefined
  const windowId = mainWindow.id
  function dispose() {
    if (cleanup) return cleanup
    removeRoutes()
    lifecycle.dispose()
    unsubscribeSettings()
    nativeTheme.off('updated', syncChrome)
    cleanup = controller.dispose().finally(() => services.dispose()).finally(() => { windows.delete(windowId); refreshTray() })
    return cleanup
  }
  windows.set(windowId, { window: mainWindow, controller, dispose })
  refreshTray()
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('focus', () => mainWindow.flashFrame(false))
  mainWindow.once('closed', () => { void dispose().catch(() => {}) })
  try {
    if (initialDirectory) await controller.chooseWorkspace()
    await mainWindow.loadFile(rendererFile)
  } catch (error) {
    if (!mainWindow.isDestroyed()) mainWindow.destroy()
    await dispose()
    throw error
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => showWindow())
  app.on('before-quit', event => {
    if (shuttingDown || !windows.size) return
    event.preventDefault()
    shuttingDown = true
    for (const notification of notifications) notification.close()
    tray?.destroy()
    tray = null
    void Promise.allSettled([...windows.values()].map(item => item.dispose())).finally(() => app.quit())
  })
  app.on('window-all-closed', () => app.quit())
  void app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.dcode.desktop')
    tray = new Tray(createTrayIcon())
    tray.on('click', () => showWindow())
    tray.on('double-click', () => showWindow())
    await openWorkbench()
  }).catch(() => {
    dialog.showErrorBox('DCODE Desktop 启动失败', '请确认桌面工程已构建且 Electron 安装完整。')
    app.quit()
  })
}
