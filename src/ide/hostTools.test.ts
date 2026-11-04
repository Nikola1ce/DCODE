// 宿主工具注册、权限门控与连接内调用生命周期回归测试。
// 制作人：Moriarty_Dox

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '../core/agent.js'
import type { PermissionDecision, ToolContext, ToolDefinition } from '../core/types.js'
import { ALL_TOOLS, executeToolCall, getTool, toOpenAITools } from '../tools/index.js'
import { globalToolRegistry } from '../tools/registry.js'
import {
  HOST_TOOL_LIMITS,
  HostToolRegistry,
  type HostToolDeclaration,
  type HostToolMessage,
  type HostToolRegistryOptions,
} from './hostTools.js'

const declaration = (patch: Partial<HostToolDeclaration> = {}): HostToolDeclaration => ({
  name: 'host__inspect', description: '检查宿主状态',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  readOnly: true, requiresPermission: false, ...patch,
})

const context = (patch: Partial<ToolContext> = {}): ToolContext => ({
  cwd: process.cwd(), permissionMode: 'default', abortSignal: new AbortController().signal,
  runId: 'run-1', toolCallId: 'tool-1',
  config: {
    provider: 'custom', baseURL: 'https://example.invalid', model: 'test',
    theme: 'dark', showThinking: false, reasoningEffort: 'high', alwaysAllow: [],
    totalCostUsd: 0, onboardingComplete: true, hooksEnabled: false,
    soundEnabled: false, soundVolume: 0,
  },
  requestPermission: async () => 'allow_once', todos: [], setTodos: () => {}, ...patch,
})

const registries = new Set<HostToolRegistry>()
function setup(
  declarations: HostToolDeclaration[] = [declaration()],
  sendImpl?: HostToolRegistryOptions['send'],
) {
  const messages: HostToolMessage[] = []
  const send = vi.fn((message: HostToolMessage) => {
    messages.push(message)
    return sendImpl?.(message)
  })
  const registry = new HostToolRegistry({ getTool, send })
  registries.add(registry)
  registry.register(declarations)
  const calls = () => messages.filter((message): message is Extract<HostToolMessage, { type: 'host_tool_call' }> =>
    message.type === 'host_tool_call')
  return { registry, messages, send, calls }
}

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const sizedSchema = (bytes: number) => {
  const schema = { type: 'object', description: '' }
  schema.description = 'x'.repeat(bytes - byteLength(schema))
  return schema
}

// 单项均合法，仅用整体 UTF-8 字节数触发快照边界。
function sizedSnapshot(bytes: number): HostToolDeclaration[] {
  const snapshot = Array.from({ length: HOST_TOOL_LIMITS.maxTools }, (_, i) =>
    declaration({ name: `host__item_${i}`, description: 'x' }))
  let remaining = bytes - byteLength(snapshot)
  for (const item of snapshot) {
    const padding = Math.min(remaining, HOST_TOOL_LIMITS.maxDescriptionBytes - 1)
    item.description += 'x'.repeat(padding)
    remaining -= padding
  }
  expect(remaining).toBe(0)
  return snapshot
}

afterEach(() => {
  for (const registry of registries) registry.disconnect()
  registries.clear()
  globalToolRegistry.registerBuiltin(ALL_TOOLS)
  globalToolRegistry.registerMcp([])
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('HostToolRegistry 快照注册', () => {
  it('完整保留声明、复制并冻结 schema，不污染全局或其他连接', () => {
    const original = declaration({ requiresPermission: true })
    const { registry } = setup([original])
    const other = setup([declaration({ description: '另一连接' })]).registry
    const tool = registry.getTool(original.name)!
    expect(toOpenAITools(registry.getTools())).toEqual([{ type: 'function', function: {
      name: original.name, description: original.description, parameters: original.parameters,
    } }])
    expect(tool.readOnly).toBe(true)
    expect(tool.safety).toEqual({ sideEffect: 'state', parallelSafe: false })
    expect(tool.checkPermission?.({ query: 'status' }, context())).toMatchObject({
      toolName: original.name, ruleKey: `HostTool(${original.name})`,
      toolCallId: 'tool-1', input: { query: 'status' }, details: { kind: 'host' },
    })
    const properties = original.parameters.properties as Record<string, { type: string }>
    properties.query.type = 'number'
    original.description = '已篡改'
    expect(tool.parameters).toMatchObject({ properties: { query: { type: 'string' } } })
    expect(Object.isFrozen(tool)).toBe(true)
    expect(Object.isFrozen(tool.parameters)).toBe(true)
    expect(Object.isFrozen(tool.parameters.properties)).toBe(true)
    registry.getTools().pop()
    expect(registry.getTools()).toEqual([tool])
    expect(getTool(original.name)).toBeUndefined()
    expect(other.getTool(original.name)?.description).toBe('另一连接')
  })

  it('成功注册替换整个快照，空数组注销全部工具', () => {
    const { registry } = setup()
    registry.register([declaration({ name: 'host__next' })])
    expect(registry.getTool('host__inspect')).toBeUndefined()
    expect(registry.getTools().map((tool) => tool.name)).toEqual(['host__next'])
    registry.register([])
    expect(registry.getTools()).toEqual([])
  })

  it('后续声明失败或同批重名时原子保留旧快照', () => {
    const { registry } = setup()
    const previous = registry.getTools()
    const next = declaration({ name: 'host__next' })
    for (const invalid of [[next, { name: 'broken' }], [next, next]]) {
      expect(() => registry.register(invalid)).toThrow()
      expect(registry.getTools()).toEqual(previous)
      expect(registry.getTools()[0]).toBe(previous[0])
      expect(registry.getTool(next.name)).toBeUndefined()
    }
  })

  it.each(['name', 'description', 'parameters', 'readOnly', 'requiresPermission'])(
    '拒绝缺少必填字段 %s', (field) => {
      const { registry } = setup()
      const invalid: Record<string, unknown> = { ...declaration() }
      delete invalid[field]
      expect(() => registry.register([invalid])).toThrow()
      expect(registry.getTools()).toHaveLength(1)
    },
  )

  it.each([
    ['空名称', { name: '' }], ['非法名称', { name: 'host.tool' }],
    ['过长名称', { name: 'a'.repeat(65) }], ['空描述', { description: '  ' }],
    ['只读字段类型', { readOnly: 'true' }], ['权限字段类型', { requiresPermission: 0 }],
    ['未知字段', { hidden: true }], ['负超时', { timeoutMs: -1 }],
    ['小数超时', { timeoutMs: 1.5 }], ['字符串超时', { timeoutMs: '1' }],
    ['过大超时', { timeoutMs: HOST_TOOL_LIMITS.maxTimeoutMs + 1 }],
  ])('拒绝无效声明：%s', (_label, patch) => {
    const { registry } = setup()
    expect(() => registry.register([{ ...declaration(), ...patch as object }])).toThrow()
  })

  it.each([
    null, [], { type: 'array' }, { type: 'object', properties: [] },
    { type: 'object', properties: { query: 'string' } },
    { type: 'object', properties: { query: { type: 'invalid' } } },
    { type: 'object', required: ['query', 'query'] }, { type: 'object', allOf: [] },
    { type: 'object', additionalProperties: 1 }, { type: 'object', maxProperties: -1 },
    { type: 'object', dependentRequired: { query: [1] } },
  ])('拒绝无效 JSON Schema %#', (parameters) => {
    const { registry } = setup()
    expect(() => registry.register([{ ...declaration(), parameters }])).toThrow()
  })

  it.each(['read_file', 'mcp__demo__inspect', 'MCP__demo__inspect'])(
    '拒绝内建工具名称或 MCP 保留前缀：%s', (name) => {
      const { registry } = setup()
      expect(() => registry.register([declaration({ name })])).toThrow(/冲突/)
    },
  )

  it('即使 MCP 名称不带保留前缀也拒绝冲突', () => {
    globalToolRegistry.registerMcp([{
      ...declaration({ name: 'dynamic_tool' }), run: async () => ({ llmContent: 'MCP' }),
    }])
    const { registry } = setup()
    expect(() => registry.register([declaration({ name: 'dynamic_tool' })])).toThrow(/冲突/)
  })

  it('工具数量、名称长度和超时允许边界值，数量超限时保留旧快照', () => {
    const { registry } = setup()
    registry.register(Array.from({ length: HOST_TOOL_LIMITS.maxTools }, (_, i) =>
      declaration({ name: `tool_${i}` })))
    expect(registry.getTools()).toHaveLength(HOST_TOOL_LIMITS.maxTools)
    expect(() => registry.register(Array.from({ length: HOST_TOOL_LIMITS.maxTools + 1 }, (_, i) =>
      declaration({ name: `tool_${i}` })))).toThrow()
    expect(registry.getTools()).toHaveLength(HOST_TOOL_LIMITS.maxTools)
    registry.register([declaration({ name: 'a'.repeat(64), timeoutMs: HOST_TOOL_LIMITS.maxTimeoutMs })])
    expect(registry.getTools()[0].name).toHaveLength(64)
  })

  it('描述和 schema 按 UTF-8 字节数限制，允许恰好等于上限', () => {
    const { registry } = setup()
    registry.register([declaration({
      description: 'x'.repeat(HOST_TOOL_LIMITS.maxDescriptionBytes),
      parameters: sizedSchema(HOST_TOOL_LIMITS.maxSchemaBytes),
    })])
    expect(() => registry.register([declaration({
      description: '中'.repeat(Math.ceil(HOST_TOOL_LIMITS.maxDescriptionBytes / 3)),
    })])).toThrow(/description/)
    expect(() => registry.register([declaration({
      parameters: sizedSchema(HOST_TOOL_LIMITS.maxSchemaBytes + 1),
    })])).toThrow(/schema/)
  })

  it('快照整体大小允许上限，超出一字节也不能部分注册', () => {
    const { registry } = setup()
    registry.register(sizedSnapshot(HOST_TOOL_LIMITS.maxSnapshotBytes))
    const previous = registry.getTools()
    expect(() => registry.register(sizedSnapshot(HOST_TOOL_LIMITS.maxSnapshotBytes + 1))).toThrow(/字节/)
    expect(registry.getTools()).toEqual(previous)
  })

  it('拒绝非 JSON、循环结构、过深结构和非数组快照', () => {
    const { registry } = setup()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    let deep: unknown = {}
    for (let i = 0; i < 70; i++) deep = { nested: deep }
    for (const extra of [NaN, Infinity, () => {}, 1n, circular, deep]) {
      expect(() => registry.register([declaration({ parameters: { type: 'object', extra } })])).toThrow()
    }
    for (const snapshot of [null, {}, '[]']) expect(() => registry.register(snapshot)).toThrow()
  })
})

describe('宿主工具权限与 plan 门控', () => {
  it.each([
    { mode: 'bypass' as const, whitelist: [] },
    { mode: 'default' as const, whitelist: ['HostTool(host__inspect)', '*'] },
    { mode: 'bypass' as const, whitelist: ['HostTool(host__inspect)', '*'] },
    { mode: 'plan' as const, whitelist: ['HostTool(host__inspect)'] },
  ])('$mode / 白名单 $whitelist 仍等待 requiresPermission 确认', async ({ mode, whitelist }) => {
    const { registry, send, calls } = setup([declaration({ requiresPermission: true })])
    let decide!: (decision: PermissionDecision) => void
    const requestPermission = vi.fn(() => new Promise<PermissionDecision>((resolve) => { decide = resolve }))
    const ctx = context({ permissionMode: mode, requestPermission })
    ctx.config.alwaysAllow = whitelist
    const pending = executeToolCall({ id: 'model-call', name: 'host__inspect', argsJson: '{"query":"status"}' },
      ctx, registry.getTool('host__inspect'))
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledOnce())
    expect(send).not.toHaveBeenCalled()
    expect(registry.pendingCount).toBe(0)
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'model-call', input: { query: 'status' }, details: expect.objectContaining({ kind: 'host' }),
    }))
    decide('allow_once')
    await vi.waitFor(() => expect(calls()).toHaveLength(1))
    expect(calls()[0].toolCallId).toBe('model-call')
    registry.acceptResult(calls()[0].hostCallId, { llmContent: 'approved' })
    expect((await pending).result).toEqual({ llmContent: 'approved' })
  })

  it('拒绝确认不会发送调用；无需确认的工具不请求权限', async () => {
    const { registry, calls } = setup([declaration({ requiresPermission: true })], (message) => {
      if (message.type === 'host_tool_call') registry.acceptResult(message.hostCallId, { llmContent: 'ok' })
    })
    const requestPermission = vi.fn(async (): Promise<PermissionDecision> => 'deny')
    const ctx = context({ permissionMode: 'bypass', requestPermission })
    const call = { id: 'model-call', name: 'host__inspect', argsJson: '{}' }
    expect((await executeToolCall(call, ctx, registry.getTool(call.name))).result.isError).toBe(true)
    expect(calls()).toHaveLength(0)
    registry.register([declaration()])
    expect((await executeToolCall(call, ctx, registry.getTool(call.name))).result).toEqual({ llmContent: 'ok' })
    expect(requestPermission).toHaveBeenCalledOnce()
  })

  it('等待确认时取消立即结束，迟到的批准不能再调用宿主', async () => {
    const { registry, send } = setup([declaration({ requiresPermission: true })])
    const controller = new AbortController()
    let approve!: (decision: PermissionDecision) => void
    const requestPermission = vi.fn(() => new Promise<PermissionDecision>((resolve) => { approve = resolve }))
    const pending = executeToolCall({ id: 'call', name: 'host__inspect', argsJson: '{}' },
      context({ abortSignal: controller.signal, requestPermission }), registry.getTool('host__inspect'))
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledOnce())
    controller.abort()
    expect((await pending).result).toMatchObject({ isError: true, llmContent: expect.stringContaining('取消') })
    approve('allow_once')
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    expect(registry.pendingCount).toBe(0)
  })

  it('plan 仅向模型暴露只读宿主工具，执行层仍拦截伪造的写工具调用', async () => {
    const { registry, send } = setup([
      declaration(), declaration({ name: 'host__write', readOnly: false, requiresPermission: true }),
    ])
    const agent = new Agent({
      cwd: process.cwd(), config: context().config,
      initialMessages: [{ role: 'system', content: 'test' }], permissionMode: 'plan',
    })
    agent.setHostTools(registry.getTools())
    const planTools = agent['getToolsForMode']('plan')
    expect(planTools.every((tool) => tool.readOnly)).toBe(true)
    expect(planTools.some((tool) => tool.name === 'host__inspect')).toBe(true)
    expect(planTools.some((tool) => tool.name === 'host__write')).toBe(false)
    expect(agent['getToolsForMode']('default').some((tool) => tool.name === 'host__write')).toBe(true)
    const requestPermission = vi.fn(async (): Promise<PermissionDecision> => 'allow_once')
    const result = await executeToolCall({ id: 'forged', name: 'host__write', argsJson: '{}' },
      context({ permissionMode: 'plan', requestPermission }), registry.getTool('host__write'))
    expect(result.result).toMatchObject({ isError: true, llmContent: expect.stringContaining('规划模式') })
    expect(requestPermission).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('局部覆盖定义与调用名称不符时不能执行', async () => {
    const { registry, send } = setup()
    const result = await executeToolCall({ id: 'forged', name: 'read_file', argsJson: '{}' },
      context(), registry.getTool('host__inspect'))
    expect(result.result.isError).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('HostToolRegistry 调用生命周期', () => {
  beforeEach(() => vi.useFakeTimers())

  it('传递关联 ID、参数和完整结果，重复或其他连接的结果不被消费', async () => {
    const { registry, calls, messages } = setup()
    const other = setup().registry
    const ctx = context()
    const removeListener = vi.spyOn(ctx.abortSignal, 'removeEventListener')
    const pending = registry.getTool('host__inspect')!.run({ query: 'status' }, ctx)
    expect(calls()[0]).toEqual({
      type: 'host_tool_call', hostCallId: expect.any(String), requestId: 'run-1',
      toolCallId: 'tool-1', name: 'host__inspect', input: { query: 'status' },
    })
    const result = { llmContent: 'done', uiSummary: '完成', isError: false,
      changedFiles: [{ path: 'src/test.ts', operation: 'edit' as const, added: 2, removed: 1 }] }
    const id = calls()[0].hostCallId
    expect(other.acceptResult(id, result)).toBe(false)
    expect(registry.acceptResult('unknown', result)).toBe(false)
    expect(registry.acceptResult(id, result)).toBe(true)
    const resolved = await pending
    expect(resolved).toEqual(result)
    expect(resolved).not.toBe(result)
    result.changedFiles[0].path = 'mutated'
    expect(resolved.changedFiles?.[0].path).toBe('src/test.ts')
    expect(registry.acceptResult(id, { llmContent: 'duplicate' })).toBe(false)
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledOnce()
    expect(messages).toHaveLength(1)
  })

  it('宿主报告的错误保留为 ToolResult 而非抛异常', async () => {
    const { registry, calls } = setup()
    const pending = registry.getTool('host__inspect')!.run({}, context())
    registry.acceptResult(calls()[0].hostCallId, { llmContent: 'host failure', isError: true })
    expect(await pending).toEqual({ llmContent: 'host failure', isError: true })
  })

  it.each([
    null, {}, { llmContent: 1 }, { llmContent: 'ok', uiSummary: false },
    { llmContent: 'ok', isError: 'false' }, { llmContent: 'ok', unknown: true },
    { llmContent: 'ok', changedFiles: {} },
    { llmContent: 'ok', changedFiles: [{ path: 'a', action: 'unknown' }] },
    { llmContent: 'ok', changedFiles: [{ path: 'a', action: 'created', additions: -1 }] },
  ])('无效结果 %# 结算为错误并清理等待项', async (result) => {
    const { registry, calls } = setup()
    const pending = registry.getTool('host__inspect')!.run({}, context())
    expect(registry.acceptResult(calls()[0].hostCallId, result)).toBe(true)
    expect(await pending).toMatchObject({ isError: true, llmContent: expect.stringContaining('无效') })
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('结果最大体积允许边界，超过一字节返回工具错误', async () => {
    const { registry, calls } = setup()
    for (const extra of [0, 1]) {
      const result = { llmContent: 'x'.repeat(HOST_TOOL_LIMITS.maxResultBytes - byteLength({ llmContent: '' }) + extra) }
      const pending = registry.getTool('host__inspect')!.run({}, context())
      registry.acceptResult(calls().at(-1)!.hostCallId, result)
      const resolved = await pending
      if (extra) expect(resolved).toMatchObject({ isError: true, llmContent: expect.stringContaining('字节') })
      else expect(resolved).toEqual(result)
      expect(registry.pendingCount).toBe(0)
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('超时只发送一次取消，迟到结果不会复活调用', async () => {
    const { registry, calls, messages } = setup([declaration({ timeoutMs: 25 })])
    const ctx = context()
    const removeListener = vi.spyOn(ctx.abortSignal, 'removeEventListener')
    const pending = registry.getTool('host__inspect')!.run({}, ctx)
    await vi.advanceTimersByTimeAsync(24)
    expect(registry.pendingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ isError: true, llmContent: expect.stringContaining('超时（25ms）') })
    expect(messages).toEqual([calls()[0], { type: 'host_tool_cancel', hostCallId: calls()[0].hostCallId }])
    expect(registry.acceptResult(calls()[0].hostCallId, { llmContent: 'late' })).toBe(false)
    expect(removeListener).toHaveBeenCalledOnce()
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('仅 ask_user 和 host__ask_user 默认无限等待，近似名称仍默认五分钟', async () => {
    const names = ['ask_user', 'host__ask_user', 'other__ask_user', 'ask_user_extra', 'host__inspect']
    const { registry, calls } = setup(names.map((name) => declaration({ name })))
    const pending = names.map((name) => registry.getTool(name)!.run({}, context()))
    expect(vi.getTimerCount()).toBe(3)
    await vi.advanceTimersByTimeAsync(HOST_TOOL_LIMITS.defaultTimeoutMs)
    expect(registry.pendingCount).toBe(2)
    for (const promise of pending.slice(2)) expect(await promise).toMatchObject({ isError: true })
    await vi.advanceTimersByTimeAsync(HOST_TOOL_LIMITS.maxTimeoutMs)
    expect(registry.pendingCount).toBe(2)
    calls().slice(0, 2).forEach((call) => registry.acceptResult(call.hostCallId, { llmContent: 'answer' }))
    expect(await Promise.all(pending.slice(0, 2))).toEqual([{ llmContent: 'answer' }, { llmContent: 'answer' }])
  })

  it.each([
    { name: 'ask_user', timeoutMs: 10 }, { name: 'host__inspect', timeoutMs: 0 },
  ])('显式 timeoutMs=$timeoutMs 覆盖 $name 的默认行为', async ({ name, timeoutMs }) => {
    const { registry, calls } = setup([declaration({ name, timeoutMs })])
    const pending = registry.getTool(name)!.run({}, context())
    await vi.advanceTimersByTimeAsync(HOST_TOOL_LIMITS.maxTimeoutMs)
    if (timeoutMs) {
      expect(await pending).toMatchObject({ isError: true, llmContent: expect.stringContaining('超时') })
    } else {
      expect(registry.pendingCount).toBe(1)
      registry.acceptResult(calls()[0].hostCallId, { llmContent: 'done' })
      expect(await pending).toEqual({ llmContent: 'done' })
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('调用前已取消不发送；调用中取消清理监听器、计时器且不重复取消', async () => {
    const { registry, calls, messages } = setup()
    const controller = new AbortController()
    const ctx = context({ abortSignal: controller.signal })
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const tool = registry.getTool('host__inspect')!
    const pending = tool.run({}, ctx)
    controller.abort()
    expect(await pending).toMatchObject({ isError: true, llmContent: expect.stringContaining('取消') })
    controller.abort()
    expect(await tool.run({}, ctx)).toMatchObject({ isError: true })
    expect(calls()).toHaveLength(1)
    expect(messages.filter((message) => message.type === 'host_tool_cancel')).toHaveLength(1)
    expect(registry.acceptResult(calls()[0].hostCallId, { llmContent: 'late' })).toBe(false)
    expect(removeListener).toHaveBeenCalledOnce()
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('断线结算全部并发调用，取消发送失败也不能中断清理', async () => {
    const { registry, calls, messages } = setup(undefined, (message) => {
      if (message.type === 'host_tool_cancel') throw new Error('transport closed')
    })
    const tool = registry.getTool('host__inspect')!
    const contexts = Array.from({ length: 3 }, () => context())
    const removes = contexts.map((ctx) => vi.spyOn(ctx.abortSignal, 'removeEventListener'))
    const pending = contexts.map((ctx) => tool.run({}, ctx))
    registry.disconnect()
    registry.disconnect()
    expect((await Promise.all(pending)).every((result) => result.isError && result.llmContent.includes('断开'))).toBe(true)
    expect(messages.filter((message) => message.type === 'host_tool_cancel')).toHaveLength(3)
    expect(await tool.run({}, context())).toMatchObject({ isError: true })
    expect(() => registry.register([])).toThrow(/断开/)
    expect(registry.getTools()).toEqual([])
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    for (const remove of removes) expect(remove).toHaveBeenCalledOnce()
    for (const call of calls()) expect(registry.acceptResult(call.hostCallId, { llmContent: 'late' })).toBe(false)
  })

  it.each(['同步异常', '异步拒绝'])('发送失败（%s）返回错误并释放所有资源', async (kind) => {
    const { registry, messages } = setup(undefined, () => {
      if (kind === '同步异常') throw new Error('send failed')
      return Promise.reject(new Error('send failed'))
    })
    expect(await registry.getTool('host__inspect')!.run({}, context())).toMatchObject({
      isError: true, llmContent: expect.stringContaining('发送失败'),
    })
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(messages.filter((message) => message.type === 'host_tool_cancel')).toHaveLength(1)
  })

  it.each(['结果', '取消', '断线'])('send 同步触发%s时已建立等待项且只结算一次', async (action) => {
    const controller = new AbortController()
    const { registry, messages } = setup(undefined, (message) => {
      if (message.type !== 'host_tool_call') return
      if (action === '结果') registry.acceptResult(message.hostCallId, { llmContent: 'sync' })
      else if (action === '取消') controller.abort()
      else registry.disconnect()
    })
    const result = await registry.getTool('host__inspect')!.run({}, context({ abortSignal: controller.signal }))
    if (action === '结果') expect(result).toEqual({ llmContent: 'sync' })
    else expect(result.isError).toBe(true)
    expect(messages.filter((message) => message.type === 'host_tool_cancel')).toHaveLength(action === '结果' ? 0 : 1)
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['结果', '取消'])('先%s后 send Promise 迟到拒绝不再结算或产生未处理异常', async (action) => {
    let rejectSend!: (error: Error) => void
    const { registry, calls, messages } = setup(undefined, (message) => {
      if (message.type === 'host_tool_call') return new Promise<void>((_resolve, reject) => { rejectSend = reject })
    })
    const controller = new AbortController()
    const pending = registry.getTool('host__inspect')!.run({}, context({ abortSignal: controller.signal }))
    if (action === '结果') registry.acceptResult(calls()[0].hostCallId, { llmContent: 'first' })
    else controller.abort()
    const result = await pending
    rejectSend(new Error('late failure'))
    await Promise.resolve()
    await Promise.resolve()
    expect(await pending).toBe(result)
    expect(messages.filter((message) => message.type === 'host_tool_cancel')).toHaveLength(action === '结果' ? 0 : 1)
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('同名并发调用按唯一 hostCallId 关联，乱序返回不串结果', async () => {
    const { registry, calls } = setup()
    const pending = [1, 2].map((i) => registry.getTool('host__inspect')!.run({ i },
      context({ runId: `run-${i}`, toolCallId: `tool-${i}` })))
    expect(new Set(calls().map((call) => call.hostCallId)).size).toBe(2)
    registry.acceptResult(calls()[1].hostCallId, { llmContent: 'second' })
    registry.acceptResult(calls()[0].hostCallId, { llmContent: 'first' })
    expect(await Promise.all(pending)).toEqual([{ llmContent: 'first' }, { llmContent: 'second' }])
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('达到并发上限拒绝新调用，释放后可重用，断线清理全部等待项', async () => {
    const { registry, calls } = setup()
    const tool = registry.getTool('host__inspect')!
    const pending = Array.from({ length: HOST_TOOL_LIMITS.maxPendingCalls }, () => tool.run({}, context()))
    expect(registry.pendingCount).toBe(HOST_TOOL_LIMITS.maxPendingCalls)
    expect(await tool.run({}, context())).toMatchObject({ isError: true, llmContent: expect.stringContaining('过多') })
    expect(calls()).toHaveLength(HOST_TOOL_LIMITS.maxPendingCalls)
    registry.acceptResult(calls()[0].hostCallId, { llmContent: 'released' })
    pending.push(tool.run({}, context()))
    expect(registry.pendingCount).toBe(HOST_TOOL_LIMITS.maxPendingCalls)
    registry.disconnect()
    const results = await Promise.all(pending)
    expect(results[0]).toEqual({ llmContent: 'released' })
    expect(results.slice(1).every((result) => result.isError)).toBe(true)
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('替换或移除声明使旧定义不可再次调用，但已发送调用仍可结算', async () => {
    const { registry, calls } = setup()
    const previous = registry.getTool('host__inspect')!
    const pending = previous.run({}, context())
    registry.register([declaration({ description: 'new snapshot' })])
    expect(await previous.run({}, context())).toMatchObject({ isError: true })
    const current = registry.getTool('host__inspect')!
    registry.register([])
    expect(await current.run({}, context())).toMatchObject({ isError: true })
    expect(calls()).toHaveLength(1)
    registry.acceptResult(calls()[0].hostCallId, { llmContent: 'old call finished' })
    expect(await pending).toEqual({ llmContent: 'old call finished' })
  })

  it('调用时再次检查后注册的 MCP 同名冲突', async () => {
    const { registry, send } = setup()
    const tool = registry.getTool('host__inspect')!
    globalToolRegistry.registerMcp([{ ...tool, run: async () => ({ llmContent: 'MCP' }) }])
    expect(await tool.run({}, context())).toMatchObject({ isError: true, llmContent: expect.stringContaining('冲突') })
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['runId', 'toolCallId'] as const)('缺少 %s 时不发送调用', async (field) => {
    const { registry, send } = setup()
    const ctx = context({ [field]: undefined })
    expect(await registry.getTool('host__inspect')!.run({}, ctx)).toMatchObject({ isError: true })
    expect(send).not.toHaveBeenCalled()
    expect(registry.pendingCount).toBe(0)
  })
})
