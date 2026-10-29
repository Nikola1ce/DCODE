// 输入区动态高度回归：补全菜单与长输入不得挤出终端，裁剪不影响编辑原文。
// 制作人：Moriarty_Dox
import React from 'react'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import type { DCodeConfig } from '../config.js'
import { getSlashSuggestions } from '../commands/index.js'
import { CommandMenu } from './CommandMenu.js'
import { InputPrompt } from './InputPrompt.js'
import { strCols } from './textLayout.js'

afterEach(cleanup)
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const config = { provider: 'custom', model: 'test-model' } as DCodeConfig

function frame(view: ReturnType<typeof render>) {
  return stripVTControlCharacters(view.lastFrame() ?? '')
}

function expectFits(view: ReturnType<typeof render>, rows: number, columns: number) {
  const lines = frame(view).split('\n')
  expect(lines.length, frame(view)).toBeLessThanOrEqual(rows)
  for (const line of lines) expect(strCols(line), line).toBeLessThanOrEqual(columns)
}

async function resize(view: ReturnType<typeof render>, columns: number) {
  await tick()
  Object.defineProperty(view.stdout, 'columns', { configurable: true, value: columns })
  view.stdout.emit('resize')
  await tick()
}

describe('CommandMenu 高度预算', () => {
  it.each([1, 2, 4, 5, 8, 12])('%i 行预算中选中项始终可见且中文说明不换行', async (maxRows) => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd${i}`, completion: `/cmd${i}`,
      description: '很长的中文命令说明\n仍然只能占用一行'.repeat(3),
    }))
    const view = render(React.createElement(CommandMenu, { items, selectedIndex: 17, maxRows }))
    await resize(view, 24)
    expect(frame(view)).toContain('❯ /cmd17')
    expectFits(view, maxRows, 24)
  })
})

describe('InputPrompt 显示窗口', () => {
  it('长中文输入随光标平移，窗口缩放和裁剪不改变提交内容', async () => {
    const onSubmit = vi.fn()
    const original = '起点' + '检查中文及英文 Mixed 输入 '.repeat(20) + '终点'
    const view = render(React.createElement(InputPrompt, {
      onSubmit, isActive: true, history: [], getConfig: () => config, maxRows: 2,
    }))
    await resize(view, 24)
    view.stdin.write(original)
    await tick()
    expect(frame(view)).toContain('终点')
    expectFits(view, 1, 24)
    view.stdin.write('\u0001') // Ctrl+A，全选后左移到起点
    await tick()
    expectFits(view, 1, 24)
    view.stdin.write('\u001b[D')
    await tick()
    expect(frame(view)).toContain('起点')
    view.stdin.write('BEGIN-')
    await tick()
    await resize(view, 16)
    expectFits(view, 1, 16)
    view.stdin.write('\u0005') // Ctrl+E，移到末尾
    await tick()
    view.stdin.write('-END')
    await tick()
    expect(frame(view)).toContain('终点-END')
    expectFits(view, 1, 16)
    view.stdin.write('\r')
    await tick()
    expect(onSubmit).toHaveBeenCalledWith(`BEGIN-${original}-END`)
  })

  it('历史中的多行输入只占一行，提交保留原来的换行', async () => {
    const onSubmit = vi.fn()
    const original = '第一行\n第二行\tTAIL'
    const view = render(React.createElement(InputPrompt, {
      onSubmit, isActive: true, history: [original], getConfig: () => config, maxRows: 1,
    }))
    await resize(view, 24)
    view.stdin.write('\u001b[A')
    await tick()
    expect(frame(view)).toContain('TAIL')
    expectFits(view, 1, 24)
    view.stdin.write('\r')
    await tick()
    expect(onSubmit).toHaveBeenCalledWith(original)
  })

  it('两行输入区仍可滚动选择全部补全命令', async () => {
    const onSubmit = vi.fn()
    const view = render(React.createElement(InputPrompt, {
      onSubmit, isActive: true, history: [], getConfig: () => config, maxRows: 2,
    }))
    await resize(view, 24)
    view.stdin.write('/')
    await tick()
    view.stdin.write('\u001b[A') // 循环到最后一项
    await tick()
    const suggestions = getSlashSuggestions('/', config)
    const last = suggestions[suggestions.length - 1]
    expect(frame(view)).toContain(last.completion)
    expectFits(view, 2, 24)
    view.stdin.write('\r')
    await tick()
    expect(onSubmit).toHaveBeenCalledWith(last.completion)
  })

  it('仅剩输入行时不会执行不可见的补全选项', async () => {
    const onSubmit = vi.fn()
    const view = render(React.createElement(InputPrompt, {
      onSubmit, isActive: true, history: [], getConfig: () => config, maxRows: 1,
    }))
    await resize(view, 24)
    view.stdin.write('/')
    await tick()
    expectFits(view, 1, 24)
    view.stdin.write('\r')
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('/')
  })
})
