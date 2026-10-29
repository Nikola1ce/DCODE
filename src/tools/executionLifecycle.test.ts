import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_TOOLS, executeToolCall } from './index.js'
import { globalToolRegistry } from './registry.js'
import { executeToolBatch } from '../core/toolScheduler.js'
import type { PermissionDecision, ToolContext, ToolDefinition } from '../core/types.js'

const context = (signal = new AbortController().signal): ToolContext => ({
  cwd: process.cwd(), permissionMode: 'default', abortSignal: signal,
  config: { provider: 'custom', baseURL: 'https://example.invalid', model: 'test',
    theme: 'dark', showThinking: false, reasoningEffort: 'high', alwaysAllow: [],
    totalCostUsd: 0, onboardingComplete: true, hooksEnabled: false, soundEnabled: false, soundVolume: 0 },
  requestPermission: async () => 'allow_once', todos: [], setTodos: () => {},
})
const makeTool = (name = 'lifecycle_tool'): ToolDefinition => ({
  name, description: name, readOnly: false, parameters: { type: 'object', properties: {} },
  checkPermission: () => ({ toolName: name, title: name, ruleKey: name }),
  run: vi.fn(async () => ({ llmContent: 'executed' })),
})
afterEach(() => globalToolRegistry.registerBuiltin(ALL_TOOLS))

describe('工具执行边界', () => {
  it('已取消的调用不请求授权、不执行工具', async () => {
    const tool = makeTool()
    globalToolRegistry.registerBuiltin([tool])
    const ac = new AbortController()
    ac.abort()
    const ctx = context(ac.signal)
    ctx.requestPermission = vi.fn()
    const result = await executeToolCall({ id: 'call', name: tool.name, argsJson: '{}' }, ctx)
    expect(result.result).toMatchObject({ isError: true, llmContent: '操作已取消。' })
    expect(ctx.requestPermission).not.toHaveBeenCalled()
    expect(tool.run).not.toHaveBeenCalled()
  })

  it('取消正在等待的授权立即完成，晚到的允许也不执行', async () => {
    const tool = makeTool()
    globalToolRegistry.registerBuiltin([tool])
    const ac = new AbortController()
    const ctx = context(ac.signal)
    let allow!: () => void
    ctx.requestPermission = vi.fn(() => new Promise<PermissionDecision>((resolve) => { allow = () => resolve('allow_once') }))
    const pending = executeToolCall({ id: 'call', name: tool.name, argsJson: '{}' }, ctx)
    await vi.waitFor(() => expect(ctx.requestPermission).toHaveBeenCalledOnce())
    ac.abort()
    await expect(pending).resolves.toMatchObject({ result: { isError: true, llmContent: '操作已取消。' } })
    allow()
    await Promise.resolve()
    expect(tool.run).not.toHaveBeenCalled()
  })

  it('授权返回允许的同时取消也不能执行副作用', async () => {
    const tool = makeTool()
    globalToolRegistry.registerBuiltin([tool])
    const ac = new AbortController()
    const ctx = context(ac.signal)
    ctx.requestPermission = async () => { ac.abort(); return 'allow_always' }
    const result = await executeToolCall({ id: 'call', name: tool.name, argsJson: '{}' }, ctx)
    expect(result.result.isError).toBe(true)
    expect(tool.run).not.toHaveBeenCalled()
  })

  it('全局注册但不在本轮工具集合的调用被拒绝', async () => {
    const hidden = makeTool('task')
    globalToolRegistry.registerBuiltin([hidden])
    const ctx = context()
    const onToolEnd = vi.fn()
    const [result] = await executeToolBatch({
      toolCalls: [{ id: 'call', name: hidden.name, argsJson: '{}' }], availableTools: [],
      baseCtx: ctx, abortSignal: ctx.abortSignal, callbacks: { onToolEnd },
    })
    expect(result.executed.result).toMatchObject({ isError: true })
    expect(result.executed.result.llmContent).toContain('当前运行中不可用')
    expect(hidden.run).not.toHaveBeenCalled()
    expect(onToolEnd).toHaveBeenCalledOnce()
  })

  it('普通允许的调用仍可执行并返回结果', async () => {
    const tool = makeTool()
    globalToolRegistry.registerBuiltin([tool])
    const result = await executeToolCall({ id: 'call', name: tool.name, argsJson: '{}' }, context())
    expect(result.result.llmContent).toBe('executed')
    expect(tool.run).toHaveBeenCalledOnce()
  })
})
