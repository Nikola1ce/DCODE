// 普通文本输入冒烟测试（覆盖「中文输入落后一拍 / 丢字符」修复与光标编辑）。
// 使用 ink-testing-library 挂载 <InputPrompt>，逐字写入（含多字节中文、一次性多字、
// 退格、左移光标后中间插入、提交），断言每一步渲染/回调结果。
// 不触发任何网络请求，仅验证 UI 与键盘交互。
// 制作人：Moriarty_Dox

import React from 'react'
import { render } from 'ink-testing-library'
import { InputPrompt } from '../src/ui/InputPrompt.js'

// ANSI 转义：左方向键、回车。
const ARROW_LEFT = '\u001B[D'
const ENTER = '\r'

// 记录 onSubmit 收到的值。
const submitted: string[] = []

const { stdin, lastFrame, unmount } = render(
  React.createElement(InputPrompt, {
    isActive: true,
    history: [],
    onSubmit: (v: string) => submitted.push(v),
  }),
)

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const frame = (): string => lastFrame() ?? ''

async function run(): Promise<void> {
  // 等待 useInput 的 effect 完成 stdin 监听注册（仅测试环境需要）。
  await delay(200)

  const checks: string[] = []
  const expect = (name: string, cond: boolean): void => {
    checks.push(name + '=' + (cond ? 'OK' : 'FAIL'))
  }

  // 1) 第一个中文字 → 必须“立即”显示（修复前会落后一拍不显示）。
  stdin.write('你')
  await delay(80)
  expect('first', frame().includes('你'))

  // 2) 累积输入。
  stdin.write('好')
  await delay(80)
  expect('second', frame().includes('你好'))

  // 3) 一次性输入多字（模拟词组/粘贴）。
  stdin.write('世界')
  await delay(80)
  expect('multi', frame().includes('你好世界'))

  // 4) 退格删除末尾一个字。
  stdin.write('\u007f')
  await delay(80)
  expect('backspace', frame().includes('你好世') && !frame().includes('你好世界'))

  // 5) 左移光标两格后在中间插入字符 → “你X好世”。
  stdin.write(ARROW_LEFT)
  await delay(40)
  stdin.write(ARROW_LEFT)
  await delay(40)
  stdin.write('X')
  await delay(80)
  expect('midInsert', frame().includes('你X好世'))

  // 6) 回车提交，onSubmit 应收到完整文本。
  stdin.write(ENTER)
  await delay(80)
  expect('submit', submitted.length === 1 && submitted[0] === '你X好世')

  unmount()

  const allOk = checks.every((c) => c.endsWith('OK'))
  process.stdout.write((allOk ? 'INPUT_OK ' : 'INPUT_FAIL ') + checks.join(' ') + '\n')
  process.exit(allOk ? 0 : 1)
}

run()
