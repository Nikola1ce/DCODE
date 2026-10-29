// 登录动态区回归：小窗口与长密钥只影响显示，不改变提交内容。
// 制作人：Moriarty_Dox
import React from 'react'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { LoginPrompt } from './LoginPrompt.js'
import { strCols } from './textLayout.js'

afterEach(cleanup)
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const loginProps = {
  providerId: 'custom' as const, providerName: '自定义供应商',
  platformUrl: 'https://example.test/' + 'long-path/'.repeat(20),
  baseURL: 'https://example.test/v1', apiKeyEnv: 'CUSTOM_API_KEY',
}

function expectFits(view: ReturnType<typeof render>, rows: number, columns: number) {
  const frame = stripVTControlCharacters(view.lastFrame() ?? '')
  const lines = frame.split('\n')
  expect(lines.length, frame).toBeLessThanOrEqual(rows)
  for (const line of lines) expect(strCols(line), line).toBeLessThanOrEqual(columns)
  return frame
}

describe('LoginPrompt 高度预算', () => {
  it.each([[3, 16], [4, 24], [7, 16], [11, 24], [24, 80]])(
    '%i 行 × %i 列输入长密钥时仍可提交完整原文', async (maxRows, columns) => {
      const onSubmit = vi.fn()
      const view = render(React.createElement(LoginPrompt, {
        ...loginProps, maxRows, onSubmit, onCancel() {},
      }))
      await tick()
      Object.defineProperty(view.stdout, 'columns', { configurable: true, value: columns })
      view.stdout.emit('resize')
      await tick()
      const key = 'test-secret-' + 'x'.repeat(300)
      view.stdin.write(key)
      await tick()
      const frame = expectFits(view, maxRows, columns)
      expect(frame).toContain('设置')
      expect(frame).toContain('Key ❯')
      expect(frame).toContain('回车提交')
      expect(frame).not.toContain('test-secret')
      view.stdin.write('\r')
      await tick()
      expect(onSubmit).toHaveBeenCalledWith(key)
    },
  )

  it('输入中缩小窗口后仍可删除并取消', async () => {
    const onSubmit = vi.fn(), onCancel = vi.fn()
    const view = render(React.createElement(LoginPrompt, {
      ...loginProps, maxRows: 11, onSubmit, onCancel,
    }))
    await tick()
    view.stdin.write('test-secret-' + 'y'.repeat(80))
    await tick()
    Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 16 })
    view.stdout.emit('resize')
    view.rerender(React.createElement(LoginPrompt, {
      ...loginProps, maxRows: 3, onSubmit, onCancel,
    }))
    await tick()
    expectFits(view, 3, 16)
    view.stdin.write('\u007f')
    await tick()
    expectFits(view, 3, 16)
    view.stdin.write('\u001b')
    await tick()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
