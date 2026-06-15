// toolScheduler 单元测试。
// 验证只读工具并行、副作用工具串行，以及子代理工具集排除 task。

import { afterEach, describe, expect, it } from 'vitest'
import { ALL_TOOLS, getSubAgentTools } from '../tools/index.js'
import { globalToolRegistry } from '../tools/registry.js'
import { executeToolBatch } from './toolScheduler.js'
import type { ToolCall, ToolContext, ToolDefinition } from './types.js'

const baseCtx: ToolContext = {
  cwd: process.cwd(),
  config: {
    baseURL: 'http://example.test',
    model: 'test-model',
    theme: 'dark',
    showThinking: false,
    reasoningEffort: 'high',
    alwaysAllow: [],
    totalCostUsd: 0,
    onboardingComplete: true,
    hooksEnabled: false,
    soundEnabled: true,
    soundVolume: 100,
    provider: 'custom',
  },
  permissionMode: 'bypass',
  abortSignal: new AbortController().signal,
  requestPermission: async () => 'allow_once',
  todos: [],
  setTodos: () => {},
}

afterEach(() => {
  globalToolRegistry.registerBuiltin(ALL_TOOLS)
})

describe('executeToolBatch', () => {
  it('连续只读工具并行执行', async () => {
    let running = 0
    let maxRunning = 0
    const makeTool = (name: string): ToolDefinition => ({
      name,
      description: name,
      readOnly: true,
      safety: { sideEffect: 'none', parallelSafe: true },
      parameters: { type: 'object', properties: {} },
      run: async () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((r) => setTimeout(r, 30))
        running--
        return { llmContent: name }
      },
    })
    const tools = [makeTool('parallel_a'), makeTool('parallel_b')]
    globalToolRegistry.registerBuiltin([...ALL_TOOLS, ...tools])

    const calls: ToolCall[] = tools.map((t, i) => ({
      id: String(i),
      name: t.name,
      argsJson: '{}',
    }))
    await executeToolBatch({
      toolCalls: calls,
      availableTools: tools,
      baseCtx,
      abortSignal: baseCtx.abortSignal,
    })

    expect(maxRunning).toBe(2)
  })

  it('副作用工具按模型顺序串行执行', async () => {
    const order: string[] = []
    const makeTool = (
      name: string,
      sideEffect: 'fs_write' | 'shell',
    ): ToolDefinition => ({
      name,
      description: name,
      readOnly: false,
      safety: { sideEffect, parallelSafe: false },
      parameters: { type: 'object', properties: {} },
      run: async () => {
        order.push(`${name}:start`)
        await new Promise((r) => setTimeout(r, 20))
        order.push(`${name}:end`)
        return { llmContent: name }
      },
    })
    const tools = [makeTool('write_like', 'fs_write'), makeTool('shell_like', 'shell')]
    globalToolRegistry.registerBuiltin([...ALL_TOOLS, ...tools])

    await executeToolBatch({
      toolCalls: tools.map((t, i) => ({ id: String(i), name: t.name, argsJson: '{}' })),
      availableTools: tools,
      baseCtx,
      abortSignal: baseCtx.abortSignal,
    })

    expect(order).toEqual([
      'write_like:start',
      'write_like:end',
      'shell_like:start',
      'shell_like:end',
    ])
  })
})

describe('getSubAgentTools', () => {
  it('排除 task，防止子代理递归启动子代理', () => {
    expect(getSubAgentTools('default').some((t) => t.name === 'task')).toBe(false)
  })
})
