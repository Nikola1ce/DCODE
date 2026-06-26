// 终端 OSC 背景色兼容检测单测。
// 制作人：Moriarty_Dox

import { afterEach, describe, expect, it, vi } from 'vitest'
import { supportsTerminalBackgroundOsc } from './terminalBackground.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('supportsTerminalBackgroundOsc', () => {
  it('DCODE_TERMINAL_BG=0 强制关闭', () => {
    vi.stubEnv('DCODE_TERMINAL_BG', '0')
    vi.stubEnv('WT_SESSION', '1')
    expect(supportsTerminalBackgroundOsc()).toBe(false)
  })

  it('DCODE_TERMINAL_BG=1 强制开启', () => {
    vi.stubEnv('DCODE_TERMINAL_BG', '1')
    expect(supportsTerminalBackgroundOsc()).toBe(true)
  })

  it('WT_SESSION 识别为现代终端（需 TTY）', () => {
    vi.stubEnv('WT_SESSION', 'abc')
    vi.stubEnv('TERM', 'xterm-256color')
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    })
    expect(supportsTerminalBackgroundOsc()).toBe(true)
  })
})
