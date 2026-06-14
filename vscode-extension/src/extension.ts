// DCODE VS Code 扩展 —— 激活入口。
// 负责：注册侧边栏对话视图、注册右键/命令面板命令（解释/修复/重构/加入对话/新建会话/重启），
// 并在停用时释放后台内核。所有 AI 能力都委托给后台 dcode --ide-server 内核，扩展只做编辑器集成。
// 制作人：Moriarty_Dox

import * as path from 'node:path'
import * as vscode from 'vscode'
import { DcodePanelProvider } from './panelProvider'
import { initEditorApply } from './editorApply'

// 模块级单例：面板提供者（持有后台内核）。在 activate 中创建，deactivate 中释放。
let panelProvider: DcodePanelProvider | undefined

/**
 * 扩展激活：VS Code 在首次需要本扩展（视图可见或命令触发）时调用。
 * @param context 扩展上下文（用于登记 Disposable、读取安装路径等）。
 */
export function activate(context: vscode.ExtensionContext): void {
  // 统一的日志输出通道（“输出”面板中可见，便于排查内核通信）。
  const output = vscode.window.createOutputChannel('DCODE')
  context.subscriptions.push(output)

  // 初始化「代码应用 / diff 预览」模块（提供临时文件目录）。
  initEditorApply(context)

  // 创建并注册侧边栏对话面板。
  panelProvider = new DcodePanelProvider(
    context.extensionUri,
    context.extensionPath,
    output,
  )
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DcodePanelProvider.viewId,
      panelProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    panelProvider,
  )

  // —— 注册命令 —— //
  context.subscriptions.push(
    vscode.commands.registerCommand('dcode.openChat', async () => {
      await panelProvider?.reveal()
      await panelProvider?.ensureStarted()
    }),
    vscode.commands.registerCommand('dcode.explainSelection', () =>
      runSelectionCommand('解释下面这段代码的功能、实现思路与潜在问题：', true),
    ),
    vscode.commands.registerCommand('dcode.fixSelection', () =>
      runSelectionCommand(
        '下面这段代码可能存在 bug 或问题，请定位并给出修复方案（先说明问题，再给出修正后的完整代码）：',
        true,
      ),
    ),
    vscode.commands.registerCommand('dcode.refactorSelection', () =>
      runSelectionCommand(
        '请在不改变行为的前提下重构下面这段代码，提升可读性与可维护性，并简述你的改动：',
        true,
      ),
    ),
    // 「加入上下文」：把当前选区作为「上下文 chip」附件加入对话（类 Cursor），
    // 不把整段代码文本塞进输入框，而是以可移除的 chip 形式携带，发送时更省 token。
    vscode.commands.registerCommand('dcode.addSelectionToContext', () =>
      addSelectionToContext(),
    ),
    vscode.commands.registerCommand('dcode.addSelectionToChat', () =>
      runSelectionCommand('', false),
    ),
    // 资源管理器右键「加入 DCODE 上下文」：支持文件与文件夹、单选与多选
    //（uri 为右键直接命中的那一项，uris 为框选/Ctrl 多选的完整集合）。
    // 文件夹会在 panelProvider 侧浅层展开其直接子文件，统一转为相对路径附件回填到对话 chips。
    vscode.commands.registerCommand(
      'dcode.addFilesToChat',
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        // 多选时 VS Code 通过第二个参数传入完整选中集合；否则回退到单个 uri。
        const targets =
          uris && uris.length > 0 ? uris : uri ? [uri] : []
        if (targets.length === 0) {
          void vscode.window.showWarningMessage('DCODE：请在资源管理器中选择文件或文件夹后再试。')
          return
        }
        await panelProvider?.addFilesToChat(targets)
      },
    ),
    vscode.commands.registerCommand('dcode.newSession', () => {
      panelProvider?.newSession()
      void vscode.window.showInformationMessage('DCODE：已新建会话（已清空上下文）。')
    }),
    vscode.commands.registerCommand('dcode.restart', async () => {
      await panelProvider?.restartKernel()
      void vscode.window.showInformationMessage('DCODE：后台内核已重启。')
    }),
  )
}

/**
 * 读取当前编辑器选区并交给面板：注入上下文或直接发起对话。
 * @param prompt 预填提问（空字符串表示仅注入代码、不预填问题）。
 * @param autoSend 是否在注入后自动发送。
 */
async function runSelectionCommand(
  prompt: string,
  autoSend: boolean,
): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    void vscode.window.showWarningMessage('DCODE：没有活动的编辑器。')
    return
  }
  const selection = editor.selection
  const code = editor.document.getText(selection)
  if (!code.trim()) {
    void vscode.window.showWarningMessage('DCODE：请先选中要处理的代码。')
    return
  }
  // 计算相对工作区的路径（展示用），失败则用文件名。
  const fsPath = editor.document.uri.fsPath
  const relPath = vscode.workspace.asRelativePath(fsPath) || path.basename(fsPath)
  const languageId = editor.document.languageId

  await panelProvider?.injectSelection(prompt, code, languageId, relPath, autoSend)
}

/**
 * 把当前编辑器选区作为「上下文 chip」附件加入对话面板。
 * 与 runSelectionCommand 的「注入文本」不同：此处构造一个 selection 类型的
 * ContextAttachment（含相对路径、起止行、代码片段、语言），交给面板以可移除的
 * chip 形式展示并随下一轮发送，避免把整段代码塞进输入框，更省 token、更直观。
 */
async function addSelectionToContext(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    void vscode.window.showWarningMessage('DCODE：没有活动的编辑器。')
    return
  }
  const selection = editor.selection
  const code = editor.document.getText(selection)
  if (!code.trim()) {
    void vscode.window.showWarningMessage('DCODE：请先选中要加入上下文的代码。')
    return
  }
  // 相对工作区路径（展示用），失败则回退到文件名。
  const fsPath = editor.document.uri.fsPath
  const relPath = vscode.workspace.asRelativePath(fsPath) || path.basename(fsPath)
  const languageId = editor.document.languageId
  // VS Code 选区行号为 0 基，转换为 1 基以便展示与提示模型。
  const startLine = selection.start.line + 1
  const endLine = selection.end.line + 1

  await panelProvider?.addSelectionToContext({
    relPath,
    startLine,
    endLine,
    snippet: code,
    languageId,
  })
}

/**
 * 扩展停用：释放后台内核与资源。
 */
export function deactivate(): void {
  panelProvider?.dispose()
  panelProvider = undefined
}
