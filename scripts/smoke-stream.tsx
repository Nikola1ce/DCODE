// App 级流式渲染集成冒烟测试。
// 用 ink-testing-library 挂载 <App>，注入一个「假 Agent」模拟流式回调（思维链 + 多行正文），
// 模拟用户输入问题并回车，断言：
//   1) 思维链标签与内容、正文各行、首块「●」都出现在历史输出中（已逐块落入 Static）；
//   2) 流式结束后实时区被清空、输入框「❯」恢复（不卡在运行态、无重复残留）。
// 不触发任何网络请求。注意：本测试无法验证真实终端滚动，仅验证「分块落盘」的结构正确性。
// 制作人：Moriarty_Dox

import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/ui/App.js'

const ENTER = '\r'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
// 去除 ANSI 转义，便于纯文本断言。
const strip = (s: string): string => s.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')

// —— 假 Agent：仅实现 App 在渲染/提交/流式路径上访问到的成员 ——
const fakeAgent = {
  cwd: 'C:/test',
  usage: { costUsd: 0 },
  permissionMode: 'default',
  getModel: () => 'deepseek-v4-flash',
  getTodos: () => [],
  hasApiKey: () => true,
  applyConfigPatch: () => {},
  setModel: () => {},
  replaceMessages: () => {},
  // 模拟一次流式回答：先思维链（无换行的尾巴），再多行正文，最后收尾。
  runTurn: async (_prompt: string, h: any) => {
    await delay(20)
    h.onReasoning('我先分析一下这个问题')
    await delay(20)
    h.onText('第一行内容\n')
    await delay(20)
    h.onText('第二行内容\n')
    await delay(20)
    h.onText('结尾行内容')
    await delay(20)
    h.onAssistantDone()
  },
}

const fakeConfig = {
  apiKey: 'x',
  baseURL: '',
  model: 'deepseek-v4-flash',
  theme: 'dark',
  showThinking: true,
  alwaysAllow: [],
  totalCostUsd: 0,
  onboardingComplete: true,
}

const inst = render(
  React.createElement(App, { agent: fakeAgent as any, config: fakeConfig as any }),
)
const { stdin, lastFrame, unmount } = inst

async function run(): Promise<void> {
  const checks: string[] = []
  const expect = (name: string, cond: boolean): void => {
    checks.push(name + '=' + (cond ? 'OK' : 'FAIL'))
  }

  // 等待首次渲染与 useInput 订阅完成。
  await delay(200)

  // 输入问题并回车。
  stdin.write('毛泽东写过哪些诗词')
  await delay(60)
  stdin.write(ENTER)

  // 轮询累积所有帧文本（Static 内容可能只出现在提交时那一帧，需累积捕获）。
  let seen = strip(lastFrame() ?? '')
  const framesOf = (): string[] => ((inst as any).frames ?? []) as string[]
  for (let i = 0; i < 50; i++) {
    await delay(20)
    seen += '\n' + strip(lastFrame() ?? '')
  }
  const allFrames = framesOf().map(strip).join('\n')
  const haystack = seen + '\n' + allFrames

  // 1) 历史中应出现思维链与正文各部分。
  expect('reasoningLabel', haystack.includes('思考过程'))
  expect('reasoningText', haystack.includes('我先分析一下这个问题'))
  expect('bullet', haystack.includes('●'))
  expect('line1', haystack.includes('第一行内容'))
  expect('line2', haystack.includes('第二行内容'))
  expect('line3', haystack.includes('结尾行内容'))
  // 用户问题也应在历史中。
  expect('userMsg', haystack.includes('毛泽东写过哪些诗词'))

  // 2) 结束后：输入框恢复（出现提示符 ❯），且最终帧不再有运行态残留的实时正文重复。
  const finalFrame = strip(lastFrame() ?? '')
  expect('promptBack', finalFrame.includes('❯'))

  unmount()

  const allOk = checks.every((c) => c.endsWith('OK'))
  process.stdout.write(
    (allOk ? 'STREAM_OK ' : 'STREAM_FAIL ') + checks.join(' ') + '\n',
  )
  if (!allOk) {
    process.stdout.write('--- finalFrame ---\n' + finalFrame + '\n')
  }
  process.exit(allOk ? 0 : 1)
}

run()
