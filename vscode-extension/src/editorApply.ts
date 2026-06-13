// DCODE VS Code 扩展 —— 把对话中的代码应用到编辑器 / diff 预览。
// 提供三种「代码落地」能力，供对话面板代码块上的按钮调用：
//   - applyCodeToEditor：把代码写入当前活动编辑器（有选区替换选区，无选区替换全文，整文替换前确认）；
//   - showDiffPreview：在并排 diff 中预览「当前文件 ↔ 应用后内容」，看完再决定是否应用；
//   - copyToClipboard：复制到系统剪贴板（WebView 沙箱禁用 clipboard API 时的兜底）。
// 设计取舍：diff 的「应用后内容」写入扩展全局存储目录下的临时文件（带原扩展名以获得语法高亮），
// 通过 vscode.diff 打开；临时文件复用同一路径，避免堆积。
// 制作人：Moriarty_Dox

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

// 临时 diff 文件的目录与扩展上下文（在 activate 时初始化）。
let storageDir: string | undefined

/**
 * 初始化模块所需的存储目录（扩展激活时调用一次）。
 * @param context 扩展上下文（取其 globalStorageUri 作为临时文件目录）。
 */
export function initEditorApply(context: vscode.ExtensionContext): void {
  storageDir = context.globalStorageUri.fsPath
}

/**
 * 获取「目标编辑器」：优先当前活动文本编辑器；若活动的是 WebView 等非文本编辑器，
 * 则回退到最近一个可见的文本编辑器。
 * @returns 目标文本编辑器；无则返回 undefined。
 */
function getTargetEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor
  if (active) return active
  // 活动项不是文本编辑器时，取第一个可见文本编辑器兜底。
  return vscode.window.visibleTextEditors[0]
}

/**
 * 计算「把代码应用到编辑器后」的完整文档文本。
 * 规则：有非空选区则替换选区，否则替换整个文档。
 * @param editor 目标编辑器。
 * @param code 要应用的代码。
 * @returns { after, replacedSelection } 应用后的全文与是否替换了选区。
 */
function computeAfterContent(
  editor: vscode.TextEditor,
  code: string,
): { after: string; replacedSelection: boolean } {
  const doc = editor.document
  const sel = editor.selection
  if (sel && !sel.isEmpty) {
    const before = doc.getText(new vscode.Range(doc.positionAt(0), sel.start))
    const after = doc.getText(
      new vscode.Range(sel.end, doc.positionAt(doc.getText().length)),
    )
    return { after: before + code + after, replacedSelection: true }
  }
  return { after: code, replacedSelection: false }
}

/**
 * 把代码应用到当前编辑器。
 * - 有非空选区：替换选区；
 * - 无选区：替换整个文档（执行前弹确认，避免误覆盖）。
 * @param code 要应用的代码。
 */
export async function applyCodeToEditor(code: string): Promise<void> {
  const editor = getTargetEditor()
  if (!editor) {
    void vscode.window.showWarningMessage('DCODE：没有可应用的编辑器，请先打开一个文件。')
    return
  }
  const doc = editor.document
  const sel = editor.selection
  const hasSelection = sel && !sel.isEmpty

  if (!hasSelection) {
    // 整文替换风险较高，先确认。
    const fileName = path.basename(doc.fileName || '当前文件')
    const choice = await vscode.window.showWarningMessage(
      `未选中代码：将用该代码块替换整个文件「${fileName}」。是否继续？`,
      { modal: true },
      '替换整个文件',
    )
    if (choice !== '替换整个文件') return
  }

  const edit = new vscode.WorkspaceEdit()
  if (hasSelection) {
    edit.replace(doc.uri, new vscode.Range(sel.start, sel.end), code)
  } else {
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length),
    )
    edit.replace(doc.uri, fullRange, code)
  }
  const ok = await vscode.workspace.applyEdit(edit)
  if (ok) {
    // 应用成功后聚焦该编辑器，便于用户查看结果。
    await vscode.window.showTextDocument(doc, editor.viewColumn)
    void vscode.window.showInformationMessage(
      hasSelection ? 'DCODE：已替换选中代码。' : 'DCODE：已替换整个文件。',
    )
  } else {
    void vscode.window.showErrorMessage('DCODE：应用代码失败。')
  }
}

/**
 * 预览「当前文件 ↔ 应用后内容」的并排 diff。
 * 把应用后的完整内容写入临时文件，再用 vscode.diff 打开对比；用户看完可手动应用。
 * @param code 要应用的代码。
 * @param languageId 代码语言（用于临时文件扩展名 / 语法高亮）。
 */
export async function showDiffPreview(code: string, languageId: string): Promise<void> {
  const editor = getTargetEditor()
  if (!editor) {
    // 没有目标文件时，直接打开一个「建议代码」的只读预览。
    const doc = await vscode.workspace.openTextDocument({
      content: code,
      language: languageId || 'plaintext',
    })
    await vscode.window.showTextDocument(doc, { preview: true })
    return
  }

  const { after } = computeAfterContent(editor, code)
  const tmpUri = await writeTempFile(after, editor.document, languageId)
  if (!tmpUri) {
    void vscode.window.showErrorMessage('DCODE：无法创建 diff 预览临时文件。')
    return
  }
  const title = `DCODE 预览：${path.basename(editor.document.fileName || '当前文件')} ↔ 应用后`
  // 左：当前文件；右：应用后内容（临时文件）。
  await vscode.commands.executeCommand('vscode.diff', editor.document.uri, tmpUri, title, {
    preview: true,
  })
  void vscode.window.showInformationMessage(
    'DCODE：已打开 diff 预览。确认无误后，可回到对话点「应用」写入文件。',
  )
}

/**
 * 把内容写入扩展存储目录下的临时文件（带原文件扩展名，便于语法高亮）。
 * @param content 文件内容。
 * @param sourceDoc 源文档（取其扩展名）。
 * @param languageId 语言 id（无扩展名时据此推断）。
 * @returns 临时文件 URI；失败返回 undefined。
 */
async function writeTempFile(
  content: string,
  sourceDoc: vscode.TextDocument,
  languageId: string,
): Promise<vscode.Uri | undefined> {
  try {
    const dir = storageDir ?? path.join(os.tmpdir(), 'dcode-vscode')
    await fs.mkdir(dir, { recursive: true })
    const ext =
      path.extname(sourceDoc.fileName) || extForLanguage(languageId) || '.txt'
    const base = path.basename(sourceDoc.fileName || 'preview', path.extname(sourceDoc.fileName))
    const file = path.join(dir, `${base}.dcode-preview${ext}`)
    await fs.writeFile(file, content, 'utf8')
    return vscode.Uri.file(file)
  } catch {
    return undefined
  }
}

/**
 * 根据语言 id 推断文件扩展名（仅覆盖常见语言；用于无扩展名来源时给临时文件命名）。
 * @param languageId VS Code 语言标识。
 * @returns 形如 ".ts" 的扩展名；未知返回空串。
 */
function extForLanguage(languageId: string): string {
  const map: Record<string, string> = {
    typescript: '.ts',
    typescriptreact: '.tsx',
    javascript: '.js',
    javascriptreact: '.jsx',
    python: '.py',
    go: '.go',
    rust: '.rs',
    java: '.java',
    c: '.c',
    cpp: '.cpp',
    csharp: '.cs',
    json: '.json',
    yaml: '.yaml',
    html: '.html',
    css: '.css',
    markdown: '.md',
    shellscript: '.sh',
    sql: '.sql',
  }
  return map[languageId] ?? ''
}

/**
 * 复制文本到系统剪贴板（WebView clipboard API 不可用时的兜底）。
 * @param code 要复制的文本。
 */
export async function copyToClipboard(code: string): Promise<void> {
  await vscode.env.clipboard.writeText(code)
}
