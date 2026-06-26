// 终端底色控制模块。
// 通过 OSC 11 动态设置/恢复终端窗口的默认背景色，解决亮色主题下
// 「黑字写在黑底终端上看不见」的问题；退出应用时自动恢复用户原始终端配色。
// 制作人：Moriarty_Dox

import { useEffect } from 'react'
import type { ThemeName } from '../config.js'
import { getTheme } from './theme.js'

// OSC（Operating System Command）序列定界符。
const OSC = '\x1b]'
const ST = '\x1b\\'

/**
 * 当前终端是否支持 OSC 11 动态背景色。
 * 旧版 Windows conhost / 部分 SSH 终端会把 OSC 序列当作可见乱码输出；
 * 仅在可识别的现代终端上启用，其余环境仍用 Ink 主题色渲染（不写入 OSC）。
 * 可通过 DCODE_TERMINAL_BG=1 强制开启、=0 强制关闭。
 */
export function supportsTerminalBackgroundOsc(): boolean {
  const override = process.env.DCODE_TERMINAL_BG
  if (override === '0') return false
  if (override === '1') return true
  if (!process.stdout.isTTY) return false
  if (process.env.TERM === 'dumb') return false
  // Windows Terminal / VS Code 集成终端
  if (process.env.WT_SESSION) return true
  if (process.env.TERM_PROGRAM === 'vscode') return true
  // macOS / 常见 Linux 图形终端
  if (process.env.TERM_PROGRAM === 'iTerm.app') return true
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return true
  if (process.env.KONSOLE_VERSION) return true
  if (process.env.GNOME_TERMINAL_SERVICE) return true
  if (process.env.COLORTERM) return true
  if (process.platform === 'darwin') return true
  // 旧版 Windows 控制台（非 WT）对 OSC 11 支持差，默认跳过以免显示 escape 乱码。
  if (process.platform === 'win32') return false
  return true
}

/**
 * 将十六进制颜色写入终端默认背景色（OSC 11）。
 * 现代终端（Windows Terminal、iTerm2、GNOME Terminal 等）均支持。
 * @param hex 背景色，如 #F6F8FA；传 undefined 则恢复终端默认。
 * @param stdout 目标输出流，默认 process.stdout。
 */
export function applyTerminalBackground(
  hex: string | undefined,
  stdout: NodeJS.WriteStream = process.stdout,
): void {
  if (!stdout.isTTY) return
  if (!supportsTerminalBackgroundOsc()) return
  if (!hex) {
    stdout.write(`${OSC}11;default${ST}`)
    return
  }
  const color = hex.replace(/^#/, '')
  stdout.write(`${OSC}11;#${color}${ST}`)
}

/**
 * 恢复终端默认背景色（退出应用或卸载 UI 时调用）。
 * @param stdout 目标输出流，默认 process.stdout。
 */
export function resetTerminalBackground(stdout: NodeJS.WriteStream = process.stdout): void {
  if (!stdout.isTTY) return
  if (!supportsTerminalBackgroundOsc()) return
  stdout.write(`${OSC}11;default${ST}`)
}

/**
 * 随主题名同步终端底色的 React Hook。
 * 主题切换时直接写入新底色（不经过 default 中间态，避免闪烁）；
 * 组件卸载时恢复终端默认配色。
 * @param themeName 当前主题名（dark / light）。
 * @param stdout ink 提供的 stdout 流（与 TUI 渲染共用同一终端）。
 */
export function useTerminalBackground(
  themeName: ThemeName,
  stdout?: NodeJS.WriteStream,
): void {
  // 主题变化：立即应用对应底色。
  useEffect(() => {
    const stream = stdout ?? process.stdout
    applyTerminalBackground(getTheme(themeName).background, stream)
  }, [themeName, stdout])

  // 卸载：恢复用户终端原有配色，避免退出后仍停留在应用设置的底色。
  useEffect(() => {
    const stream = stdout ?? process.stdout
    return () => {
      resetTerminalBackground(stream)
    }
  }, [stdout])
}
