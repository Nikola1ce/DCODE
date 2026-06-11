// 交互界面冒烟测试。
// 使用 ink-testing-library 在无真实 TTY 的环境下挂载完整的 <App>，验证：
//   1) 组件树能正常 mount，不抛运行时错误；
//   2) 首屏渲染出 ASCII LOGO 与制作人「Moriarty_Dox」署名。
// 不提交任何输入，因此不会触发真实 API 调用。仅用于本地构建后的自检。
// 制作人：Moriarty_Dox

import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/ui/App.js'
import { Agent } from '../src/core/agent.js'
import { loadConfig } from '../src/config.js'

// 加载配置但强制清空 apiKey，确保走“需要登录”分支，绝不触网。
const config = { ...loadConfig(), apiKey: undefined }

// 构造一个不持久化、无历史的 Agent。
const agent = new Agent({
  config,
  cwd: process.cwd(),
  recorder: null,
  permissionMode: 'default',
})

// 渲染 App。
const { lastFrame, unmount } = render(
  React.createElement(App, { agent, config, needLogin: true }),
)

// 等待若干帧后检查输出。
setTimeout(() => {
  const frame = lastFrame() ?? ''
  process.stdout.write('=== FRAME START ===\n')
  process.stdout.write(frame + '\n')
  process.stdout.write('=== FRAME END ===\n')

  // 校验关键内容：制作人署名 + 产品名。
  const hasAuthor = frame.includes('Moriarty_Dox')
  const hasBrand = frame.includes('DCODE') || /DCODE/.test(frame)
  unmount()
  if (hasAuthor && hasBrand) {
    process.stdout.write('SMOKE_OK\n')
    process.exit(0)
  } else {
    process.stdout.write(`SMOKE_FAIL (author=${hasAuthor}, brand=${hasBrand})\n`)
    process.exit(1)
  }
}, 500)
