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

/** 禁止远程资源、任意 file: 读取、查询字符串绕过和未声明的本地文件。 */
export function isAllowedAssetUrl(url: string, assets: ReadonlySet<string>): boolean {
  return assets.has(url)
}
