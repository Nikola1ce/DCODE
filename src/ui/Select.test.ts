// 菜单交互回归：大列表翻页、空列表与当前模型定位。
// 制作人：Moriarty_Dox
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { Select } from './Select.js'
import { makeEventKey } from './eventKey.js'

afterEach(cleanup)
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
describe('Select', () => {
  it('显式高度预算优先于 Ink 代理尺寸，窄窗口翻页后仍显示当前选项', async () => {
    const onSelect = vi.fn()
    const options = Array.from({ length: 24 }, (_, i) => ({ value: `m${i}`, label: `模型-${i}`, hint: '模型说明' }))
    const view = render(React.createElement(Select<string>, { maxRows: 5, title: '选择模型', options, selectedValue: 'm17', onSelect, onCancel() {} }))
    Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 24 })
    view.stdout.emit('resize')
    await tick()
    expect(view.lastFrame()?.split('\n').length).toBeLessThanOrEqual(5)
    expect(view.lastFrame()).toContain('模型-17')
    view.stdin.write('\u001b[6~')
    await tick()
    expect(view.lastFrame()?.split('\n').length).toBeLessThanOrEqual(5)
    view.stdin.write('\r')
    await tick()
    expect(onSelect).toHaveBeenCalledWith('m20')
  })
  it('空菜单回车不抛异常，Esc 仍可退出', async () => {
    const onSelect = vi.fn(), onCancel = vi.fn()
    const view = render(React.createElement(Select<string>, { title: '模型', options: [], onSelect, onCancel }))
    await tick()
    view.stdin.write('\r')
    await tick()
    expect(onSelect).not.toHaveBeenCalled()
    expect(view.lastFrame()).toContain('暂无可选项')
    view.stdin.write('\u001b')
    await tick()
    expect(onCancel).toHaveBeenCalledOnce()
  })
  it('当前值在后续页仍可见，并可翻页快选', async () => {
    const onSelect = vi.fn()
    const options = Array.from({ length: 24 }, (_, i) => ({ value: `m${i}`, label: `模型-${i}`, hint: '模型说明' }))
    const view = render(React.createElement(Select<string>, { title: '模型', options, selectedValue: 'm17', onSelect, onCancel() {} }))
    await tick()
    expect(view.lastFrame()).toContain('模型-17 ✓ 当前')
    expect(view.lastFrame()).not.toContain('模型-0')
    view.stdin.write('\u001b[5~')
    await tick()
    view.stdin.write('1')
    await tick()
    expect(onSelect).toHaveBeenCalledWith('m8')
  })
  it('同一轮中每条工具进度都能更新，即使时间戳相同', () => {
    const base = { type: 'tool_progress' as const, runId: 'r', turnId: 't', iteration: 0, timestamp: 1 }
    for (const event of [{ ...base, id: 'tool1', text: '10%' }, { ...base, id: 'tool1', text: '50%' }, { ...base, id: 'tool2', text: '100%' }]) {
      expect(makeEventKey(event)).toBeNull()
    }
  })
})
