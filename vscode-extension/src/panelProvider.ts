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
import {
  applyCodeToEditor,
  copyToClipboard,
  showDiffPreview,
} from './editorApply'
import type {
  ContextAttachment,
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
        // v3+：把可切换供应商与模型列表透传给 WebView，供「点击切换」下拉菜单使用。
        providers: ready.providers,
        models: ready.models,
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
            providers: r.providers,
            models: r.models,
          })
        }
        break
      case 'send': {
        const text = String(msg.text ?? '').trim()
        // 上下文附件（通过「+ 文件/+ 文件夹」按钮或右键加入的文件/选区引用）由前端随消息带上。
        const attachments = Array.isArray(msg.attachments)
          ? (msg.attachments as ContextAttachment[])
          : undefined
        // 允许「仅附件无文本」的发送（如只加入了文件就发送）。
        if (!text && (!attachments || attachments.length === 0)) break
        const ok = await this.ensureStarted()
        if (!ok) break
        const requestId = randomUUID()
        // 回显用户消息到 WebView（含可能的轮次 id 与附件，便于关联与展示）。
        this.postToWebview({ type: 'user_message', requestId, text, attachments })
        this.client?.prompt(requestId, text, attachments)
        break
      }
      case 'slash_command': {
        // 斜杠命令：交给后台内核复用 CLI 命令系统执行。
        const input = String(msg.input ?? '').trim()
        if (!input) break
        const ok = await this.ensureStarted()
        if (!ok) break
        const requestId = randomUUID()
        // 回显用户输入的命令（作为一条用户消息），便于对话记录可读。
        // 关键：标记 isCommand=true。斜杠命令分两类——「纯本地命令」（如 /login、/help、
        // /model、/config）只会回一条 command_result，永远不会产生 turn_done；只有少数命令
        // （如 /init、/commit、/review）才会转成后台一轮 prompt（command_result.submitted=true）。
        // 因此命令回显不能像普通对话那样无条件进入「处理中（忙碌）」态，否则发送键会一直停留在
        // 「停止」按钮且点击无效（内核侧并无可中断的轮次）。是否进入忙碌态改由前端在收到
        // command_result(submitted=true) 时再决定。
        this.postToWebview({ type: 'user_message', requestId, text: input, isCommand: true })
        this.client?.slashCommand(requestId, input)
        break
      }
      case 'request_commands': {
        // 命令补全：转发给内核生成候选（内核按当前配置返回模型列表/子选项等）。
        const queryId = String(msg.queryId ?? '')
        const input = String(msg.input ?? '')
        // 未启动时静默忽略（补全是辅助功能，不强制拉起内核）。
        if (!this.client?.isRunning()) break
        this.client.requestCommands(queryId, input)
        break
      }
      case 'browse_files': {
        // 「+ 文件」/「+ 文件夹」按钮：弹出 VS Code 原生选择器，直接在扩展宿主侧拿到真实
        // URI，再复用附件收集逻辑回填到 chips（这是 100% 可靠、可发现的加入上下文入口）。
        // mode 决定选择器类型：'folder' 选文件夹、其它（默认）选文件。
        // 关键：Windows 原生对话框不支持「同时选文件和文件夹」，两者都允许时会退化成
        // 只能选文件夹（文件不显示），故这里按类型拆开，分别只允许一种。
        const mode = msg.mode === 'folder' ? 'folder' : 'file'
        await this.browseAndAddFiles(mode)
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
      case 'set_provider':
        this.client?.setProvider(String(msg.provider))
        break
      case 'submit_api_key': {
        // 面板内 /login 录入：把 API Key 交给内核保存并热更新。
        const provider = String(msg.provider ?? '')
        const apiKey = String(msg.apiKey ?? '')
        if (!apiKey.trim()) break
        const ok = await this.ensureStarted()
        if (!ok) break
        this.client?.submitApiKey(provider, apiKey)
        break
      }
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
      case 'apply_code':
        // 把对话代码块应用到当前编辑器（有选区替换选区，否则替换全文并确认）。
        await applyCodeToEditor(String(msg.code ?? ''))
        break
      case 'preview_diff':
        // 在并排 diff 中预览「当前文件 ↔ 应用后内容」。
        await showDiffPreview(String(msg.code ?? ''), String(msg.languageId ?? ''))
        break
      case 'copy_code':
        // WebView clipboard 不可用时的兜底复制。
        await copyToClipboard(String(msg.code ?? ''))
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
          // v3+：状态变更（切模型/供应商）后把最新列表透传给 WebView 刷新菜单。
          providers: msg.providers,
          models: msg.models,
        })
        break
      case 'log':
        this.postToWebview({ type: 'log', level: msg.level, message: msg.message })
        break
      case 'command_suggestions':
        this.postToWebview({
          type: 'command_suggestions',
          queryId: msg.queryId,
          suggestions: msg.suggestions,
        })
        break
      case 'command_result':
        this.postToWebview({
          type: 'command_result',
          requestId: msg.requestId,
          message: msg.message,
          cleared: msg.cleared,
          submitted: msg.submitted,
          hint: msg.hint,
        })
        break
      case 'login_prompt':
        // 内核请求面板录入 API Key：转发给 WebView 弹出安全输入框。
        this.postToWebview({
          type: 'login_prompt',
          providerId: msg.providerId,
          providerName: msg.providerName,
          platformUrl: msg.platformUrl,
          baseURL: msg.baseURL,
          apiKeyEnv: msg.apiKeyEnv,
        })
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

  /**
   * 把一段编辑器选区作为「上下文 chip」附件加入对话（供右键「加入上下文」命令调用）。
   * 与 injectSelection 不同：此处构造 selection 类型的 ContextAttachment，复用
   * 「attachments_added」通道让前端渲染为可移除的 chip，随下一轮发送，更省 token。
   * @param sel 选区信息：相对路径、起止行（1 基）、代码片段、语言标识。
   */
  async addSelectionToContext(sel: {
    relPath: string
    startLine: number
    endLine: number
    snippet: string
    languageId: string
  }): Promise<void> {
    await this.reveal()
    await this.ensureStarted()
    const attachment: ContextAttachment = {
      kind: 'selection',
      path: sel.relPath,
      startLine: sel.startLine,
      endLine: sel.endLine,
      snippet: sel.snippet,
      languageId: sel.languageId,
    }
    this.postToWebview({ type: 'attachments_added', attachments: [attachment] })
  }

  /**
   * 把一组文件加入对话上下文（供资源管理器右键命令调用）。
   * 会展开目录，过滤掉二进制/超大文件，转为相对路径附件后回填到前端 chips。
   * @param uris 选中的文件/目录 URI 列表。
   */
  async addFilesToChat(uris: vscode.Uri[]): Promise<void> {
    await this.reveal()
    await this.ensureStarted()
    const atts = await this.collectFileAttachments(uris)
    if (atts.length === 0) {
      void vscode.window.showWarningMessage('DCODE：未找到可加入的文本文件。')
      return
    }
    this.postToWebview({ type: 'attachments_added', attachments: atts })
  }

  /**
   * 弹出 VS Code 原生选择器，把所选文件/文件夹加入对话上下文。
   * 设计动机：在扩展宿主侧用 showOpenDialog 直接拿到真实 URI，再复用 collectFileAttachments
   * 走统一的过滤/相对路径/回填流程，是 100% 可靠、可发现的加入上下文入口。
   *
   * 关键限制：Windows 的原生文件对话框不支持「同时选择文件和文件夹」——当
   * canSelectFiles 与 canSelectFolders 同时为 true 时，会退化成文件夹选择器
   * （文件不显示、无法选中）。因此这里按 mode 拆成两种独立的选择器，分别只允许一种类型。
   *
   * @param mode 'file' 仅选文件（默认）；'folder' 仅选文件夹（浅层展开其直接子文件）。
   */
  async browseAndAddFiles(mode: 'file' | 'folder' = 'file'): Promise<void> {
    await this.reveal()
    await this.ensureStarted()
    // 默认打开目录：优先当前工作区根，避免每次都从用户主目录开始翻找。
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri
    const selectFolders = mode === 'folder'
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      // 二者互斥：同时为 true 会导致 Windows 上文件不可见，故按类型只开其一。
      canSelectFiles: !selectFolders,
      canSelectFolders: selectFolders,
      openLabel: '加入对话上下文',
      title: selectFolders
        ? 'DCODE：选择要加入上下文的文件夹'
        : 'DCODE：选择要加入上下文的文件',
      defaultUri,
    })
    if (!picked || picked.length === 0) return // 用户取消，无需提示。
    const atts = await this.collectFileAttachments(picked)
    if (atts.length === 0) {
      void vscode.window.showWarningMessage('DCODE：所选项中没有可加入的文本文件。')
      return
    }
    this.postToWebview({ type: 'attachments_added', attachments: atts })
  }

  /**
   * 把一组 URI（文件或目录）收集为「文件引用」附件。
   * - 目录：浅层展开其直接子文件（不递归整棵树，避免一次加入海量文件）；
   * - 跳过明显的二进制扩展名与超过约 2MB 的大文件（仅作引用，模型按需 read_file）；
   * - 路径转为相对工作区路径，便于内核与展示。
   * @param uris 文件/目录 URI 列表。
   * @returns 去重后的附件数组（最多 50 个，避免一次注入过多）。
   */
  private async collectFileAttachments(uris: vscode.Uri[]): Promise<ContextAttachment[]> {
    const out: ContextAttachment[] = []
    const seen = new Set<string>()
    const MAX_FILES = 50

    /** 把单个文件 URI 收集为附件（带类型/大小过滤）。 */
    const addFile = async (uri: vscode.Uri): Promise<void> => {
      if (out.length >= MAX_FILES) return
      const rel = vscode.workspace.asRelativePath(uri, false) || uri.fsPath
      if (seen.has(rel)) return
      // 过滤常见二进制/媒体扩展名（仍可手动在输入框引用，但不默认加入上下文）。
      if (isLikelyBinaryPath(rel)) return
      try {
        const stat = await vscode.workspace.fs.stat(uri)
        if (stat.type & vscode.FileType.Directory) return // 目录在上层已展开。
        if (stat.size > 2 * 1024 * 1024) return // 超过 2MB 跳过。
      } catch {
        return
      }
      seen.add(rel)
      out.push({ kind: 'file', path: rel })
    }

    for (const uri of uris) {
      if (out.length >= MAX_FILES) break
      let stat: vscode.FileStat | undefined
      try {
        stat = await vscode.workspace.fs.stat(uri)
      } catch {
        continue
      }
      if (stat.type & vscode.FileType.Directory) {
        // 目录：浅层展开直接子文件。
        try {
          const entries = await vscode.workspace.fs.readDirectory(uri)
          for (const [name, type] of entries) {
            if (out.length >= MAX_FILES) break
            if (type & vscode.FileType.File) {
              await addFile(vscode.Uri.joinPath(uri, name))
            }
          }
        } catch {
          // 读目录失败跳过。
        }
      } else {
        await addFile(uri)
      }
    }
    return out
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
        providers: ready.providers,
        models: ready.models,
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
      <button id="status-provider" class="status-pill" title="点击切换供应商" aria-haspopup="true">
        <span id="status-provider-label">DCODE</span>
        <span class="pill-caret">▾</span>
      </button>
      <button id="status-model" class="status-pill" title="点击切换模型" aria-haspopup="true">
        <span id="status-model-label">模型</span>
        <span class="pill-caret">▾</span>
      </button>
      <button id="status-mode" class="status-pill subtle" title="点击切换权限模式" aria-haspopup="true">
        <span id="status-mode-label"></span>
        <span class="pill-caret">▾</span>
      </button>
      <div id="status-actions">
        <button id="btn-clear" title="新建会话（清空上下文）">清空</button>
        <button id="btn-settings" title="打开 DCODE 设置">设置</button>
      </div>
    </div>
    <!-- 通用下拉选择面板：模型 / 供应商 / 权限模式共用，按需填充选项并定位到触发按钮下方。 -->
    <div id="picker" class="hidden" role="listbox" aria-label="选择">
      <div id="picker-header"></div>
      <div id="picker-list"></div>
    </div>
    <div id="messages"></div>
    <div id="composer">
      <div id="attachments" class="hidden"></div>
      <div id="composer-input-wrap">
        <div id="command-menu" class="hidden"></div>
        <textarea id="input" rows="3" placeholder="向 DCODE 提问；输入 / 使用命令（Enter 发送，Shift+Enter 换行）"></textarea>
      </div>
      <div id="composer-actions">
        <button id="btn-add-file" class="ghost-btn" title="选择文件加入上下文">+ 文件</button>
        <button id="btn-add-folder" class="ghost-btn" title="选择文件夹加入上下文（浅层展开其直接子文件）">+ 文件夹</button>
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

// 常见二进制/媒体/压缩文件扩展名：默认不加入上下文（仅引用，模型按需读取也无意义）。
const BINARY_EXTENSIONS = new Set([
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'psd',
  // 音视频
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  // 压缩/归档
  'zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz',
  // 可执行/库/字体
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'a', 'lib',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // 文档/其它二进制
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
])

/**
 * 粗略判断一个路径是否为二进制/媒体文件（按扩展名）。
 * @param p 文件路径或相对路径。
 * @returns 看起来是二进制返回 true。
 */
function isLikelyBinaryPath(p: string): boolean {
  const idx = p.lastIndexOf('.')
  if (idx < 0) return false
  const ext = p.slice(idx + 1).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}
