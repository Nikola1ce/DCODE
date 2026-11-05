// 窗口与 IPC 来源约束；纯函数便于不启动 Electron 的安全测试。
// 制作人：Moriarty_Dox
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
  "font-src 'self'", "connect-src 'none'", "media-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'",
].join('; ')

export const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
})

export interface IpcRequest {
  sender: unknown
  senderFrame?: { url: string } | null
}
export interface TrustedContents {
  mainFrame: { url: string }
  isDestroyed(): boolean
}

export function isTrustedInvocation(event: IpcRequest, owner: TrustedContents | null, rendererUrl: string): boolean {
  return !!owner && !owner.isDestroyed() && event.sender === owner
    && event.senderFrame === owner.mainFrame && event.senderFrame.url === rendererUrl
}

/** 复制操作只允许已加载本地工作台的主窗口写入文本，读取剪贴板继续由系统拒绝。 */
export function isClipboardWriteAllowed(permission: string, requester: TrustedContents | null, owner: TrustedContents | null, rendererUrl: string): boolean {
  return permission === 'clipboard-sanitized-write' && !!owner && requester === owner
    && !owner.isDestroyed() && owner.mainFrame.url === rendererUrl
}

/** 禁止远程资源、任意 file: 读取、查询字符串绕过和未声明的本地文件。 */
export function isAllowedAssetUrl(url: string, assets: ReadonlySet<string>): boolean {
  return assets.has(url)
}
