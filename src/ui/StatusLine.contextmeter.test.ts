// 状态栏上下文用量数字格式化单元测试。
// 校验 token 数以 k / m 单位显示、保留合适小数位并去除尾随 0。
// 制作人：Moriarty_Dox

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { formatTokenCount, StatusLine } from './StatusLine.js'

afterEach(cleanup)

describe('ui/StatusLine formatTokenCount', () => {
  it('紧凑状态栏优先显示上下文，长模型名不会挤掉占用与压缩阈值', async () => {
    const view = render(React.createElement(StatusLine, {
      busy: false, compact: true, model: '很长的自定义模型名字'.repeat(10),
      permissionMode: 'default', costUsd: 0, contextTokens: 150000, contextLimit: 1000000, compactThreshold: 300000,
    }))
    Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 60 })
    view.stdout.emit('resize')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(view.lastFrame()).toContain('150k/1m')
    expect(view.lastFrame()).toContain('300k 压缩')
    expect(view.lastFrame()?.split('\n')).toHaveLength(1)
  })
  it('小于 1000 显示整数', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(1)).toBe('1')
    expect(formatTokenCount(512)).toBe('512')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('千级用 k 并保留 1 位小数、去尾随 0', () => {
    expect(formatTokenCount(1000)).toBe('1k')
    expect(formatTokenCount(1500)).toBe('1.5k')
    expect(formatTokenCount(12_345)).toBe('12.3k')
    expect(formatTokenCount(60_000)).toBe('60k')
  })

  it('模型上下文窗口整刻度显示干净（128K / 200K / 400K）', () => {
    expect(formatTokenCount(128_000)).toBe('128k')
    expect(formatTokenCount(200_000)).toBe('200k')
    expect(formatTokenCount(400_000)).toBe('400k')
  })

  it('百万级用 m 并保留 2 位小数、去尾随 0', () => {
    expect(formatTokenCount(1_000_000)).toBe('1m')
    expect(formatTokenCount(1_250_000)).toBe('1.25m')
    expect(formatTokenCount(1_500_000)).toBe('1.5m')
  })

  it('负数与小数被钳制 / 四舍五入', () => {
    expect(formatTokenCount(-100)).toBe('0')
    expect(formatTokenCount(999.4)).toBe('999')
    expect(formatTokenCount(1499.6)).toBe('1.5k')
  })
})
