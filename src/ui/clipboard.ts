// 系统剪贴板读写模块（跨平台，异步，失败静默）。
//
// 背景：输入框原先的复制/剪切只写入「程序内部剪贴板」（一个内存变量），因此 Ctrl+A 全选 + Ctrl+C
// 复制的内容无法粘贴到 DCODE 之外——用户反馈「Ctrl+A 选中后复制不生效」（而鼠标选择走的是终端原生
// 复制、能进系统剪贴板，所以那条能用）。本模块把复制/剪切真正写入「系统剪贴板」，并支持读取用于粘贴。
//
// 设计（参考 sound.ts 的成熟做法）：
//   - 按平台调用系统自带命令：Windows=clip / Get-Clipboard；macOS=pbcopy / pbpaste；
//     Linux=wl-copy·xclip·xsel（按可用性回退）。
//   - 写入统一走「子进程 stdin 管道」，避免命令行转义与长度限制、并天然支持多行/Unicode。
//   - 全程异步、错误静默：剪贴板不可用绝不影响主交互（调用方仍有内部剪贴板兜底）。
//   - 执行器可注入（setClipboardBackend），便于单测在不触达真实系统剪贴板的前提下断言行为。
// 制作人：Moriarty_Dox

import { spawn } from 'node:child_process'

// 剪贴板后端：把「写入/读取」抽象为可注入接口，便于测试替身拦截。
export interface ClipboardBackend {
  // 写入文本到系统剪贴板；成功 resolve(true)，不可用/失败 resolve(false)（不 reject）。
  write: (text: string) => Promise<boolean>
  // 读取系统剪贴板文本；成功返回字符串，不可用/失败返回 null（不 reject）。
  read: () => Promise<string | null>
}

/**
 * 通过子进程 stdin 管道写入文本（用于 clip / pbcopy / xclip 等从标准输入读取的命令）。
 * @param command 命令名。
 * @param args 命令参数。
 * @param text 要写入的文本。
 * @returns 成功 true，失败 false（静默，不抛错）。
 */
function pipeToStdin(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      child.on('error', () => done(false))
      child.on('close', (code) => done(code === 0))
      // 写入文本后关闭 stdin，触发命令读取结束。
      child.stdin.on('error', () => done(false))
      child.stdin.end(text, 'utf8')
    } catch {
      resolve(false)
    }
  })
}

/**
 * 运行命令并收集其标准输出（用于 Get-Clipboard / pbpaste / xclip -o 等读取命令）。
 * @param command 命令名。
 * @param args 命令参数。
 * @returns 标准输出文本；失败返回 null（静默）。
 */
function readStdout(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      let out = ''
      let settled = false
      const done = (val: string | null): void => {
        if (settled) return
        settled = true
        resolve(val)
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        out += chunk
      })
      child.on('error', () => done(null))
      child.on('close', (code) => done(code === 0 ? out : null))
    } catch {
      resolve(null)
    }
  })
}

/**
 * 默认的跨平台剪贴板后端：按当前操作系统选择系统自带命令。
 */
const defaultBackend: ClipboardBackend = {
  async write(text: string): Promise<boolean> {
    const platform = process.platform
    if (platform === 'win32') {
      // Windows 自带 clip.exe，从 stdin 读取并写入剪贴板。
      return pipeToStdin('clip', [], text)
    }
    if (platform === 'darwin') {
      return pipeToStdin('pbcopy', [], text)
    }
    // Linux / 其它类 Unix：依次尝试 Wayland 的 wl-copy、X11 的 xclip、xsel。
    if (await pipeToStdin('wl-copy', [], text)) return true
    if (await pipeToStdin('xclip', ['-selection', 'clipboard'], text)) return true
    return pipeToStdin('xsel', ['--clipboard', '--input'], text)
  },

  async read(): Promise<string | null> {
    const platform = process.platform
    if (platform === 'win32') {
      // PowerShell Get-Clipboard 读取剪贴板文本。-Raw 保留多行原文（不按行拆数组）。
      const out = await readStdout('powershell', [
        '-NoProfile',
        '-Command',
        'Get-Clipboard -Raw',
      ])
      // PowerShell 输出：去掉末尾附加的换行，并把 Windows 的 \r\n 统一为 \n，
      // 避免粘贴进输入框的多行文本残留 \r 造成显示/提交异常。
      return out === null ? null : normalizeNewlines(stripTrailingNewline(out))
    }
    if (platform === 'darwin') {
      return readStdout('pbpaste', [])
    }
    const wl = await readStdout('wl-paste', ['--no-newline'])
    if (wl !== null) return wl
    const xclip = await readStdout('xclip', ['-selection', 'clipboard', '-o'])
    if (xclip !== null) return xclip
    return readStdout('xsel', ['--clipboard', '--output'])
  },
}

/**
 * 去除字符串尾部的一个换行（\r\n 或 \n）。
 * 仅用于规整 Get-Clipboard 等命令在输出末尾附加的换行，避免粘贴时多出空行。
 * @param s 原始字符串。
 * @returns 去掉尾部单个换行后的字符串。
 */
function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '')
}

/**
 * 把 Windows 风格换行 \r\n 统一为 \n（保留正文内容，仅规整换行符）。
 * @param s 原始字符串。
 * @returns 规整后的字符串。
 */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

// 当前生效的后端；默认跨平台实现，测试可注入替身。
let backend: ClipboardBackend = defaultBackend

/**
 * 注入自定义剪贴板后端（主要供测试；传 null 复位为默认实现）。
 * @param custom 自定义后端，或 null 表示复位。
 */
export function setClipboardBackend(custom: ClipboardBackend | null): void {
  backend = custom ?? defaultBackend
}

/**
 * 写入系统剪贴板（异步、失败静默）。
 * @param text 要写入的文本。
 * @returns 成功 true、失败 false。
 */
export function writeClipboard(text: string): Promise<boolean> {
  if (!text) return Promise.resolve(false)
  return backend.write(text)
}

/**
 * 读取系统剪贴板（异步、失败静默）。
 * @returns 文本，或 null（不可用/失败）。
 */
export function readClipboard(): Promise<string | null> {
  return backend.read()
}
