// DCODE VS Code 扩展 —— 侧边栏对话面板（WebviewViewProvider）。
// 职责：
//   - 实现 vscode.WebviewViewProvider，渲染侧边栏内的对话 WebView；
//   - 持有/复用 DcodeClient，把「服务端协议消息」翻译为「WebView 可消费的 UI 消息」并 postMessage；
//   - 把「WebView 的用户操作」（发送、取消、权限决策、切换模型/模式、清空）翻译为客户端指令；
//   - 在面板首次可见时自动启动后台内核（受 dcode.autoStart 影响）。
// WebView 前端代码在 media/main.js（不打包，运行期通过 asWebviewUri 加载）。
// 制作人：Moriarty_Dox

import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { DcodeClient, resolveWorkspaceCwd } from './dcodeClient'
import type {
  IdePermissionMode,
  PermissionDecision,
  ServerMessage,
} from './protocol'

/**
 * 侧边栏对话面板提供者。
 * 注册为 webview 视图（id=dcode.chatView），全局单例由扩展激活时创建。
 */
export class DcodePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'dcode.chatView'

  // 当前 webview 视图（侧边栏未展开时可能为 undefined）。
  private view: vscode.WebviewView | undefined
  // 后台内核客户端（懒启动）。
  private client: DcodeClient | undefined
  // 客户端消息订阅的 Disposable（重建客户端时需先取消旧订阅）。
  private clientSub: vscode.Disposable | undefined
  private clientExitSub: vscode.Disposable | undefined
  // 待 WebView 就绪后回放的消息队列（WebView 尚未加载完时收到的服务端消息先缓冲）。
  private pendingToWebview: unknown[] = []
  // WebView 是否已通知「前端就绪」。
  private webviewReady = false
  // 是否正在启动内核（避免并发重复启动）。
  private starting = false

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionPath: string,
    private readonly output: vscode.OutputChannel,
  ) {}

  /**
   * VS Code 在侧边栏视图需要渲染时调用：配置 webview 选项、注入 HTML、绑定消息通道。
   * @param view 框架提供的 webview 视图。
   */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    }
    view.webview.html = this.buildHtml(view.webview)

    // 接收 WebView 前端发来的消息。
    view.webview.onDidReceiveMessage((msg) => this.handleWebviewMessage(msg))

    // 视图可见性变化：首次可见时按需自动启动内核。
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.ensureStartedIfAuto()
    })

    // 视图被释放（用户关闭侧边栏）时清理引用，但保留内核进程以便快速恢复。
    view.onDidDispose(() => {
      this.view = undefined
      this.webviewReady = false
    })

    // 面板已渲染：若配置为自动启动则拉起内核。
    void this.ensureStartedIfAuto()
  }

  /**
   * 聚焦/展开侧边栏对话视图（供命令调用）。
   */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('dcode.chatView.focus')
  }

  /**
   * 若配置 dcode.autoStart 为真且内核未运行，则启动内核。
   */
  private async ensureStartedIfAuto(): Promise<void> {
    const autoStart = vscode.workspace
      .getConfiguration('dcode')
      .get<boolean>('autoStart', true)
    if (!autoStart) return
    await this.ensureStarted()
  }

  /**
   * 确保后台内核已启动并完成握手；失败时在 WebView 中提示。
   * @returns 启动成功返回 true。
   */
  async ensureStarted(): Promise<boolean> {
    if (this.client?.isRunning() && this.client.getReadyInfo()) return true
    if (this.starting) return false
    this.starting = true
    try {
      if (!this.client) {
        this.client = new DcodeClient({
          cwd: resolveWorkspaceCwd(),
          extensionPath: this.extensionPath,
          output: this.output,
        })
        this.clientSub = this.client.onMessage((m) => this.handleServerMessage(m))
        this.clientExitSub = this.client.onExit((info) => {
          this.postToWebview({ type: 'kernel_exit', code: info.code })
        })
      }
      this.postToWebview({ type: 'kernel_starting' })
      const ready = await this.client.start()
      this.postToWebview({
        type: 'ready',
        model: ready.model,
        provider: ready.provider,
        permissionMode: ready.permissionMode,
        cwd: ready.cwd,
        hasApiKey: ready.hasApiKey,
        version: ready.version,
      })
      return true
    } catch (e: any) {
      const message = e?.message ?? String(e)
      this.output.appendLine(`内核启动失败：${message}`)
      this.postToWebview({ type: 'kernel_error', message })
      void vscode.window.showErrorMessage(`DCODE 内核启动失败：${message}`)
      return false
    } finally {
      this.starting = false
    }
  }

  /**
   * 处理来自 WebView 前端的消息（用户操作）。
   * @param msg WebView 消息（含 type 字段）。
   */
  private async handleWebviewMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'webview_ready':
        // 前端加载完成：回放缓冲的消息，并回推当前状态。
        this.webviewReady = true
        for (const queued of this.pendingToWebview) {
          this.view?.webview.postMessage(queued)
        }
        this.pendingToWebview = []
        if (this.client?.getReadyInfo()) {
          const r = this.client.getReadyInfo()!
          this.postToWebview({
            type: 'ready',
            model: r.model,
            provider: r.provider,
            permissionMode: r.permissionMode,
            cwd: r.cwd,
            hasApiKey: r.hasApiKey,
            version: r.version,
          })
        }
        break
      case 'send': {
        const text = String(msg.text ?? '').trim()
        if (!text) break
        const ok = await this.ensureStarted()
        if (!ok) break
        const requestId = randomUUID()
        // 回显用户消息到 WebView（含可能的轮次 id，便于关联）。
        this.postToWebview({ type: 'user_message', requestId, text })
        this.client?.prompt(requestId, text)
        break
      }
      case 'cancel':
        this.client?.cancel(msg.requestId)
        break
      case 'permission_decision':
        this.client?.respondPermission(
          String(msg.permissionId),
          msg.decision as PermissionDecision,
        )
        break
      case 'set_model':
        this.client?.setModel(String(msg.model))
        break
      case 'set_permission_mode':
        this.client?.setPermissionMode(msg.mode as IdePermissionMode)
        break
      case 'clear':
        this.client?.clear()
        this.postToWebview({ type: 'cleared' })
        break
      case 'restart':
        await this.restartKernel()
        break
      case 'open_settings':
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'dcode',
        )
        break
      default:
        break
    }
  }

  /**
   * 处理后台内核的服务端消息：转换为 WebView UI 消息并下发。
   * @param msg 服务端协议消息。
   */
  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'ready':
        // 已在 ensureStarted 中处理首个 ready；此处忽略重复。
        break
      case 'reasoning':
        this.postToWebview({ type: 'reasoning', requestId: msg.requestId, delta: msg.delta })
        break
      case 'text':
        this.postToWebview({ type: 'text', requestId: msg.requestId, delta: msg.delta })
        break
      case 'tool_start':
        this.postToWebview({
          type: 'tool_start',
          requestId: msg.requestId,
          toolCallId: msg.toolCallId,
          name: msg.name,
          summary: msg.summary,
        })
        break
      case 'tool_progress':
        this.postToWebview({
          type: 'tool_progress',
          requestId: msg.requestId,
          toolCallId: msg.toolCallId,
          text: msg.text,
        })
        break
      case 'tool_end':
        this.postToWebview({
          type: 'tool_end',
          requestId: msg.requestId,
          toolCallId: msg.toolCallId,
          name: msg.name,
          isError: msg.isError,
          summary: msg.summary,
          detail: msg.detail,
        })
        break
      case 'permission_request':
        this.postToWebview({
          type: 'permission_request',
          requestId: msg.requestId,
          permissionId: msg.permissionId,
          request: msg.request,
        })
        break
      case 'turn_done':
        this.postToWebview({
          type: 'turn_done',
          requestId: msg.requestId,
          reason: msg.reason,
          costUsd: msg.costUsd,
          usage: msg.usage,
        })
        break
      case 'turn_error':
        this.postToWebview({ type: 'turn_error', requestId: msg.requestId, message: msg.message })
        break
      case 'status':
        this.postToWebview({
          type: 'status',
          model: msg.model,
          provider: msg.provider,
          permissionMode: msg.permissionMode,
        })
        break
      case 'log':
        this.postToWebview({ type: 'log', level: msg.level, message: msg.message })
        break
      default:
        break
    }
  }

  /**
   * 向 WebView 发送一条消息；WebView 未就绪时先缓冲。
   * @param msg 任意可序列化消息（含 type）。
   */
  private postToWebview(msg: unknown): void {
    if (this.view && this.webviewReady) {
      this.view.webview.postMessage(msg)
    } else {
      this.pendingToWebview.push(msg)
    }
  }

  /**
   * 把一段选区代码作为上下文注入对话输入框（供右键命令调用）。
   * @param prompt 预填的提问文本（如「解释这段代码」）。
   * @param code 选中的代码。
   * @param languageId 语言标识（用于代码围栏）。
   * @param relPath 相对路径（展示用）。
   * @param autoSend 是否自动发送（true 直接发起对话，false 仅填入输入框）。
   */
  async injectSelection(
    prompt: string,
    code: string,
    languageId: string,
    relPath: string,
    autoSend: boolean,
  ): Promise<void> {
    await this.reveal()
    await this.ensureStarted()
    this.postToWebview({
      type: 'inject_selection',
      prompt,
      code,
      languageId,
      relPath,
      autoSend,
    })
  }

  /** 新建会话：清空内核上下文并通知 WebView。 */
  newSession(): void {
    this.client?.clear()
    this.postToWebview({ type: 'cleared' })
  }

  /**
   * 重启后台内核。
   */
  async restartKernel(): Promise<void> {
    if (!this.client) {
      await this.ensureStarted()
      return
    }
    this.postToWebview({ type: 'kernel_starting' })
    try {
      const ready = await this.client.restart()
      this.postToWebview({
        type: 'ready',
        model: ready.model,
        provider: ready.provider,
        permissionMode: ready.permissionMode,
        cwd: ready.cwd,
        hasApiKey: ready.hasApiKey,
        version: ready.version,
      })
    } catch (e: any) {
      this.postToWebview({ type: 'kernel_error', message: e?.message ?? String(e) })
    }
  }

  /** 释放资源：取消订阅并停止内核。 */
  dispose(): void {
    this.clientSub?.dispose()
    this.clientExitSub?.dispose()
    this.client?.dispose()
  }

  /**
   * 构建 WebView 的 HTML 外壳：引用 media 下的 css/js，注入 CSP 与 nonce。
   * @param webview 目标 webview（用于生成安全的资源 URI）。
   * @returns 完整 HTML 字符串。
   */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce()
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'),
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'),
    )
    // 严格 CSP：只允许带 nonce 的脚本、本扩展的样式与 VS Code 内联样式。
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>DCODE</title>
</head>
<body>
  <div id="app">
    <div id="status-bar">
      <span id="status-model">DCODE</span>
      <span id="status-mode"></span>
      <div id="status-actions">
        <button id="btn-clear" title="新建会话（清空上下文）">清空</button>
        <button id="btn-settings" title="打开 DCODE 设置">设置</button>
      </div>
    </div>
    <div id="messages"></div>
    <div id="composer">
      <textarea id="input" rows="3" placeholder="向 DCODE 提问，或选中代码后右键使用解释/修复/重构…（Enter 发送，Shift+Enter 换行）"></textarea>
      <div id="composer-actions">
        <span id="hint"></span>
        <button id="btn-send">发送</button>
        <button id="btn-stop" class="hidden">停止</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

/**
 * 生成一次性 nonce（用于 CSP 脚本白名单）。
 * @returns 32 位随机十六进制字符串。
 */
function getNonce(): string {
  return randomUUID().replace(/-/g, '')
}
