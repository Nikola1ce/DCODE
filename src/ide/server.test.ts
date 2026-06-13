// IDE IPC 服务端单元测试。
// 用内存流（PassThrough）+ 假 Agent 驱动 IdeServer，覆盖：
//   - ready 握手；
//   - prompt → 事件转发（text/tool）→ turn_done；
//   - 权限请求往返（permission_request → permission_response）；
//   - 串行约束（进行中再 prompt 被拒）；
//   - 切换模型 / 权限模式回推 status；
//   - shutdown 关闭。

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeServer } from './server.js'
import {
  createLineDecoder,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol.js'
import type { Agent, TurnHandlers } from '../core/agent.js'
import type { AgentRunEvent, PermissionDecision, PermissionRequest } from '../core/types.js'

// 假 Agent：仅实现 IdeServer 用到的方法/属性。runTurn 行为可注入。
class FakeAgent {
  permissionMode = 'acceptEdits' as const
  readonly cwd = '/fake/cwd'
  usage = { inputTokens: 10, outputTokens: 20, cacheHitTokens: 0, costUsd: 0.001 }
  private model = 'fake-model'
  private sessionId: string | null = 'sess-1'
  apiKey = true
  // 注入的一轮行为：给定 handlers，产出一系列事件/回调。
  turnImpl: ((input: string, handlers: TurnHandlers) => Promise<void>) | null = null
  lastSetModel: string | null = null
  lastSetMode: string | null = null
  cleared = false

  getModel() {
    return this.model
  }
  getProviderId() {
    return 'custom' as const
  }
  hasApiKey() {
    return this.apiKey
  }
  getSessionId() {
    return this.sessionId
  }
  setModel(m: string) {
    this.model = m
    this.lastSetModel = m
  }
  setPermissionMode(m: any) {
    this.permissionMode = m
    this.lastSetMode = m
  }
  clear() {
    this.cleared = true
  }
  async runTurn(input: string, handlers: TurnHandlers) {
    if (this.turnImpl) return this.turnImpl(input, handlers)
  }
}

// 测试夹具：把 FakeAgent 接到 IdeServer，并提供「发送客户端消息 / 收集服务端消息」的工具。
function setup(agent: FakeAgent) {
  const input = new PassThrough()
  const output = new PassThrough()
  const log = new PassThrough()
  const server = new IdeServer({
    agent: agent as unknown as Agent,
    input,
    output,
    log,
  })
  const received: ServerMessage[] = []
  const decoder = createLineDecoder<ServerMessage>()
  output.on('data', (chunk: Buffer) => {
    for (const m of decoder.push(chunk)) received.push(m)
  })
  const startPromise = server.start()
  /** 向服务端发送一条客户端消息。 */
  const send = (msg: ClientMessage) => input.write(encodeMessage(msg))
  /** 等待直到 received 中出现某 type 的消息（或超时）。 */
  const waitFor = async (
    type: ServerMessage['type'],
    timeoutMs = 1000,
  ): Promise<ServerMessage> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = received.find((m) => m.type === type)
      if (found) return found
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error(`等待 ${type} 超时；已收到：${received.map((m) => m.type).join(',')}`)
  }
  return { server, input, output, received, send, waitFor, startPromise }
}

let activeServer: IdeServer | null = null
afterEach(() => {
  activeServer?.shutdown()
  activeServer = null
})

describe('IdeServer 握手与基础', () => {
  it('启动后立即发送 ready，携带模型/权限模式/API Key 状态', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    const ready = (await ctx.waitFor('ready')) as Extract<ServerMessage, { type: 'ready' }>
    expect(ready.model).toBe('fake-model')
    expect(ready.permissionMode).toBe('acceptEdits')
    expect(ready.hasApiKey).toBe(true)
    expect(ready.cwd).toBe('/fake/cwd')
    expect(ready.sessionId).toBe('sess-1')
    expect(ready.protocolVersion).toBeGreaterThan(0)
  })

  it('shutdown 消息使 start() 解析（服务端关闭）', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    await ctx.waitFor('ready')
    ctx.send({ type: 'shutdown' })
    await expect(ctx.startPromise).resolves.toBeUndefined()
  })
})

describe('IdeServer prompt 事件转发', () => {
  it('把 text_delta / tool_* / run_end 转换为协议消息并以 turn_done 收尾', async () => {
    const agent = new FakeAgent()
    // 注入一轮：产出文本、一个工具调用、然后结束。
    agent.turnImpl = async (_input, handlers) => {
      const emit = (ev: AgentRunEvent) => handlers.onEvent?.(ev)
      const base = { runId: 'run', turnId: 'turn', iteration: 0, timestamp: Date.now() }
      emit({ type: 'text_delta', ...base, delta: '你好' } as AgentRunEvent)
      emit({
        type: 'tool_start',
        ...base,
        id: 't1',
        name: 'read_file',
        summary: '读取 a.ts',
      } as AgentRunEvent)
      emit({
        type: 'tool_end',
        ...base,
        id: 't1',
        name: 'read_file',
        result: { llmContent: '文件内容', uiSummary: '已读取', isError: false },
        durationMs: 5,
      } as AgentRunEvent)
      emit({
        type: 'run_end',
        runId: 'run',
        turnId: 'turn',
        timestamp: Date.now(),
        iterations: 1,
        reason: 'final',
      } as AgentRunEvent)
    }
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'prompt', requestId: 'req1', text: 'hi' })

    const text = (await ctx.waitFor('text')) as Extract<ServerMessage, { type: 'text' }>
    expect(text.requestId).toBe('req1')
    expect(text.delta).toBe('你好')

    const toolStart = (await ctx.waitFor('tool_start')) as Extract<ServerMessage, { type: 'tool_start' }>
    expect(toolStart.name).toBe('read_file')
    expect(toolStart.toolCallId).toBe('t1')

    const toolEnd = (await ctx.waitFor('tool_end')) as Extract<ServerMessage, { type: 'tool_end' }>
    expect(toolEnd.isError).toBe(false)
    expect(toolEnd.detail).toBe('文件内容')

    const done = (await ctx.waitFor('turn_done')) as Extract<ServerMessage, { type: 'turn_done' }>
    expect(done.requestId).toBe('req1')
    expect(done.reason).toBe('final')
  })

  it('空输入返回 turn_error', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'prompt', requestId: 'reqX', text: '   ' })
    const err = (await ctx.waitFor('turn_error')) as Extract<ServerMessage, { type: 'turn_error' }>
    expect(err.requestId).toBe('reqX')
  })

  it('缺少 API Key 时 prompt 返回 turn_error', async () => {
    const agent = new FakeAgent()
    agent.apiKey = false
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'prompt', requestId: 'reqK', text: '写代码' })
    const err = (await ctx.waitFor('turn_error')) as Extract<ServerMessage, { type: 'turn_error' }>
    expect(err.message).toContain('API Key')
  })
})

describe('IdeServer 权限往返', () => {
  it('runTurn 内 requestPermission 触发 permission_request，回执后兑现决策', async () => {
    const agent = new FakeAgent()
    let resolvedDecision: PermissionDecision | null = null
    agent.turnImpl = async (_input, handlers) => {
      const req: PermissionRequest = {
        toolName: 'write_file',
        title: '写入文件 a.ts',
        ruleKey: 'Write',
      }
      resolvedDecision = await handlers.requestPermission(req)
      // 收到决策后结束本轮。
      handlers.onEvent?.({
        type: 'run_end',
        runId: 'run',
        turnId: 'turn',
        timestamp: Date.now(),
        iterations: 1,
        reason: 'final',
      } as AgentRunEvent)
    }
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'prompt', requestId: 'reqP', text: '改文件' })

    const perm = (await ctx.waitFor('permission_request')) as Extract<
      ServerMessage,
      { type: 'permission_request' }
    >
    expect(perm.request.toolName).toBe('write_file')
    expect(perm.requestId).toBe('reqP')

    ctx.send({
      type: 'permission_response',
      permissionId: perm.permissionId,
      decision: 'allow_once',
    })
    await ctx.waitFor('turn_done')
    expect(resolvedDecision).toBe('allow_once')
  })
})

describe('IdeServer 状态切换与串行约束', () => {
  it('set_model / set_permission_mode 透传给 Agent 并回推 status', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')

    ctx.send({ type: 'set_model', model: 'deepseek-v4-pro' })
    const status1 = (await ctx.waitFor('status')) as Extract<ServerMessage, { type: 'status' }>
    expect(agent.lastSetModel).toBe('deepseek-v4-pro')
    expect(status1.model).toBe('deepseek-v4-pro')

    // 清掉已收集的 status，再切权限模式。
    ctx.received.length = 0
    ctx.send({ type: 'set_permission_mode', mode: 'plan' })
    const status2 = (await ctx.waitFor('status')) as Extract<ServerMessage, { type: 'status' }>
    expect(agent.lastSetMode).toBe('plan')
    expect(status2.permissionMode).toBe('plan')
  })

  it('进行中再次 prompt 被拒（串行约束）', async () => {
    const agent = new FakeAgent()
    // 第一轮永不结束（直到 abort），用于占用 active 槽。
    const releaseRef: { fn: (() => void) | null } = { fn: null }
    agent.turnImpl = async (_input, handlers) => {
      await new Promise<void>((resolve) => {
        releaseRef.fn = resolve
        handlers.abortSignal.addEventListener('abort', () => resolve())
      })
    }
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'prompt', requestId: 'first', text: '长任务' })
    // 稍等让第一轮占住 active。
    await new Promise((r) => setTimeout(r, 30))
    ctx.send({ type: 'prompt', requestId: 'second', text: '插队' })
    const err = (await ctx.waitFor('turn_error')) as Extract<ServerMessage, { type: 'turn_error' }>
    expect(err.requestId).toBe('second')
    expect(err.message).toContain('进行中')
    releaseRef.fn?.()
  })

  it('clear 透传并回推 log + status', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'clear' })
    await ctx.waitFor('log')
    expect(agent.cleared).toBe(true)
  })
})
