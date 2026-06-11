// 命令补全菜单交互冒烟测试。
// 使用 ink-testing-library 挂载 <InputPrompt>，通过 stdin 模拟按键，验证：
//   1) 输入 "/" 后弹出命令菜单（含若干命令）；
//   2) 继续输入会按前缀过滤候选；
//   3) ↓ 方向键移动高亮；
//   4) 回车执行当前选中的命令（触发 onSubmit 且参数形如 /xxx）。
// 不触发任何网络请求，仅验证 UI 与键盘交互。
// 制作人：Moriarty_Dox

import React from 'react'
import { render } from 'ink-testing-library'
import { InputPrompt } from '../src/ui/InputPrompt.js'

// 记录 onSubmit 收到的值。
const submitted: string[] = []

// 模拟方向键等的 ANSI 转义序列。
const ARROW_DOWN = '\u001B[B'
const ENTER = '\r'

// 渲染输入框。
const { stdin, lastFrame, unmount } = render(
  React.createElement(InputPrompt, {
    isActive: true,
    history: [],
    onSubmit: (v: string) => submitted.push(v),
  }),
)

// 顺序写入按键，每步之间留出微小间隔让 React 处理状态更新。
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function run(): Promise<void> {
  // 等待 useInput 的 effect 完成 stdin 监听注册，避免首个按键丢失（仅测试环境需要）。
  await delay(200)

  // 1) 输入 "/"，应弹出命令菜单。
  stdin.write('/')
  await delay(120)
  const afterSlash = lastFrame() ?? ''
  process.stdout.write('=== 输入 "/" 后 ===\n' + afterSlash + '\n')
  const hasMenu = afterSlash.includes('命令（') && afterSlash.includes('/help')

  // 2) 继续输入 "mo"，应过滤到 /model 与 /mode、/memory 等以 m 开头项。
  stdin.write('m')
  await delay(100)
  stdin.write('o')
  await delay(120)
  const afterMo = lastFrame() ?? ''
  process.stdout.write('\n=== 输入 "/mo" 后 ===\n' + afterMo + '\n')
  const filtered = afterMo.includes('/model') && !afterMo.includes('/help')

  // 3) 方向键下移一项，再回车执行。
  stdin.write(ARROW_DOWN)
  await delay(100)
  stdin.write(ENTER)
  await delay(120)
  process.stdout.write('\n=== 回车后 onSubmit 收到 ===\n' + JSON.stringify(submitted) + '\n')

  unmount()

  // 判定：菜单出现 + 过滤生效 + 提交了一个以 / 开头的命令。
  const executed = submitted.length === 1 && submitted[0].startsWith('/')
  if (hasMenu && filtered && executed) {
    process.stdout.write('\nMENU_OK\n')
    process.exit(0)
  } else {
    process.stdout.write(
      `\nMENU_FAIL (hasMenu=${hasMenu}, filtered=${filtered}, executed=${executed})\n`,
    )
    process.exit(1)
  }
}

run()
