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
import type { DCodeConfig } from '../config.js'

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
  // 斜杠命令可能触发的热更新；测试中仅记录最后一次 patch。
  lastConfigPatch: any = null
  applyConfigPatch(patch: any) {
    this.lastConfigPatch = patch
  }
  // 记录最近一次 runTurn 的输入，便于断言附件前缀已拼接。
  lastTurnInput: string | null = null
  async runTurn(input: string, handlers: TurnHandlers) {
    this.lastTurnInput = input
    if (this.turnImpl) return this.turnImpl(input, handlers)
  }
}

// 测试夹具：把 FakeAgent 接到 IdeServer，并提供「发送客户端消息 / 收集服务端消息」的工具。
function setup(agent: FakeAgent) {
  const input = new PassThrough()
  const output = new PassThrough()
  const log = new PassThrough()
  // 最小可用配置：仅满足 IdeServer 持有/透传所需，斜杠命令测试可按需扩展。
  const fakeConfig = { provider: 'zhipu', model: 'fake-model' } as unknown as DCodeConfig
  const server = new IdeServer({
    agent: agent as unknown as Agent,
    config: fakeConfig,
    input,
    output,
    log,
    // 注入不写盘的 applyConfig，避免单测污染 ~/.dcode/config.json。
    applyConfig: () => {},
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

  it('ready/status 携带可切换供应商与模型列表', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    const ready = (await ctx.waitFor('ready')) as Extract<ServerMessage, { type: 'ready' }>
    // providers 至少包含 zhipu / deepseek / openai 三家，且恰有一个 active。
    expect(Array.isArray(ready.providers)).toBe(true)
    expect(ready.providers!.some((p) => p.id === 'zhipu')).toBe(true)
    expect(ready.providers!.some((p) => p.id === 'deepseek')).toBe(true)
    expect(ready.providers!.filter((p) => p.active).length).toBe(1)
    // models 非空（当前供应商的建议模型）。
    expect(Array.isArray(ready.models)).toBe(true)
    expect(ready.models!.length).toBeGreaterThan(0)
  })

  it('set_provider 切换供应商：透传补丁、必要时同步模型并回推 status + log', async () => {
    const agent = new FakeAgent()
    // 记录 applyConfig 收到的补丁，断言含 provider 字段。
    let lastPatch: any = null
    const input = new PassThrough()
    const output = new PassThrough()
    const log = new PassThrough()
    const fakeConfig = { provider: 'zhipu', model: 'glm-4-flash' } as unknown as DCodeConfig
    const server = new IdeServer({
      agent: agent as unknown as Agent,
      config: fakeConfig,
      input,
      output,
      log,
      applyConfig: (patch) => {
        lastPatch = patch
      },
    })
    activeServer = server
    const received: ServerMessage[] = []
    const decoder = createLineDecoder<ServerMessage>()
    output.on('data', (chunk: Buffer) => {
      for (const m of decoder.push(chunk)) received.push(m)
    })
    void server.start()
    const waitFor = async (type: ServerMessage['type'], timeoutMs = 1000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = received.find((m) => m.type === type)
        if (found) return found
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error(`等待 ${type} 超时；已收到：${received.map((m) => m.type).join(',')}`)
    }
    await waitFor('ready')
    input.write(encodeMessage({ type: 'set_provider', provider: 'deepseek' }))
    const status = (await waitFor('status')) as Extract<ServerMessage, { type: 'status' }>
    // 切到 deepseek 应带 provider 补丁；zhipu→deepseek 模型不在 deepseek 目录，会自动换默认模型。
    expect(lastPatch?.provider).toBe('deepseek')
    expect(agent.lastSetModel).toBeTruthy()
    expect(status.providers!.some((p) => p.id === 'deepseek')).toBe(true)
  })

  it('set_provider 收到不支持的供应商：回推 warn 日志且不切换', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.received.length = 0
    ctx.send({ type: 'set_provider', provider: 'ollama' })
    const logMsg = (await ctx.waitFor('log')) as Extract<ServerMessage, { type: 'log' }>
    expect(logMsg.level).toBe('warn')
    expect(logMsg.message).toContain('暂不支持')
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

describe('IdeServer 斜杠命令与补全', () => {
  it('本地命令 /help 返回 command_result 文本', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'slash_command', requestId: 'cmd1', input: '/help' })
    const res = (await ctx.waitFor('command_result')) as Extract<
      ServerMessage,
      { type: 'command_result' }
    >
    expect(res.requestId).toBe('cmd1')
    expect(res.message).toContain('可用命令')
    expect(res.submitted).toBeFalsy()
  })

  it('未知命令 /nope 返回带提示的 command_result', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'slash_command', requestId: 'cmd2', input: '/nope' })
    const res = (await ctx.waitFor('command_result')) as Extract<
      ServerMessage,
      { type: 'command_result' }
    >
    expect(res.message).toContain('未知命令')
  })

  it('/clear 命令清空会话并标记 cleared', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'slash_command', requestId: 'cmd3', input: '/clear' })
    const res = (await ctx.waitFor('command_result')) as Extract<
      ServerMessage,
      { type: 'command_result' }
    >
    expect(res.cleared).toBe(true)
    expect(agent.cleared).toBe(true)
  })

  it('/exit 在 IDE 内以 hint 提示（不退出进程）', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'slash_command', requestId: 'cmd4', input: '/exit' })
    const res = (await ctx.waitFor('command_result')) as Extract<
      ServerMessage,
      { type: 'command_result' }
    >
    expect(res.hint).toBe(true)
    expect(res.message).toContain('关闭')
  })

  it('request_commands 返回 command_suggestions（含 queryId）', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'request_commands', queryId: 'q1', input: '/he' })
    const res = (await ctx.waitFor('command_suggestions')) as Extract<
      ServerMessage,
      { type: 'command_suggestions' }
    >
    expect(res.queryId).toBe('q1')
    // '/he' 应匹配 help 命令。
    expect(res.suggestions.some((s) => s.completion === '/help')).toBe(true)
  })

  it('/login 在面板内回传 login_prompt（请求录入 Key，而非引导到终端）', async () => {
    const agent = new FakeAgent()
    const ctx = setup(agent)
    activeServer = ctx.server
    await ctx.waitFor('ready')
    ctx.send({ type: 'slash_command', requestId: 'cmdLogin', input: '/login' })
    const res = (await ctx.waitFor('login_prompt')) as Extract<
      ServerMessage,
      { type: 'login_prompt' }
    >
    // 携带当前供应商（fakeConfig.provider=zhipu）的录入元信息。
    expect(res.providerId).toBe('zhipu')
    expect(res.providerName).toBeTruthy()
    expect(res.apiKeyEnv).toBeTruthy()
  })

  it('submit_api_key 保存后回传 command_result（已保存）并回推 status', async () => {
    const agent = new FakeAgent()
    // 用可观测的 applyConfig 断言补丁确实写入 providers[provider].apiKey。
    let lastPatch: any = null
    const input = new PassThrough()
    const output = new PassThrough()
    const log = new PassThrough()
    const fakeConfig = { provider: 'zhipu', model: 'glm-4-flash' } as unknown as DCodeConfig
    const server = new IdeServer({
      agent: agent as unknown as Agent,
      config: fakeConfig,
      input,
      output,
      log,
      applyConfig: (patch) => {
        lastPatch = patch
      },
    })
    activeServer = server
    const received: ServerMessage[] = []
    const decoder = createLineDecoder<ServerMessage>()
    output.on('data', (chunk: Buffer) => {
      for (const m of decoder.push(chunk)) received.push(m)
    })
    void server.start()
    const waitFor = async (type: ServerMessage['type'], timeoutMs = 1000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = received.find((m) => m.type === type)
        if (found) return found
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error(`等待 ${type} 超时；已收到：${received.map((m) => m.type).join(',')}`)
    }
    await waitFor('ready')
    received.length = 0
    input.write(encodeMessage({ type: 'submit_api_key', provider: 'zhipu', apiKey: 'sk-test-123' }))
    const res = (await waitFor('command_result')) as Extract<
      ServerMessage,
      { type: 'command_result' }
    >
    expect(res.message).toContain('已保存')
    // 补丁应把 Key 写入 providers.zhipu.apiKey（各供应商独立）。
    expect(lastPatch?.providers?.zhipu?.apiKey).toBe('sk-test-123')
    // 保存后回推 status 以刷新面板 hasApiKey。
    await waitFor('status')
  })

  it('submit_api_key 收到空 Key 不保存，回传提示', async () => {
    const agent = new FakeAgent()
    let applyCalled = false
    const input = new PassThrough()
    const output = new PassThrough()
    const log = new PassThrough()
    const fakeConfig = { provider: 'zhipu', model: 'glm-4-flash' } as unknown as DCodeConfig
    const server = new IdeServer({
      agent: agent as unknown as Agent,
      config: fakeConfig,
      input,
      output,
      log,
      applyConfig: () => {
        applyCalled = true
      },
    })
    activeServer = server
    const received: ServerMessage[] = []
    const decoder = createLineDecoder<ServerMessage>()
    output.on('data', (chunk: Buffer) => {
      for (const m of decoder.push(chunk)) received.push(m)
    })
    void server.start()
    const waitFor = async (type: ServerMessage['type'], timeoutMs = 1000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = received.find((m) => m.type === type)
        if (found) return found
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error(`等待 ${type} 超时；已收到：${received.map((m) => m.type).join(',')}`)
    }
    await waitFor('ready')
    received.length = 0
    input.write(encodeMessage({ type: 'submit_api_key', provider: 'zhipu', apiKey: '   ' }))
    const res = (await waitFor('command_result')) as Extract<
      ServerMessage,
      { type: 'command_result' }
    >
    expect(res.message).toContain('为空')
    expect(applyCalled).toBe(false)
  })

  it('prompt 携带 attachments 时把上下文清单拼接到输入前', async () => {
    const agent = new FakeAgent()
    // 注入一轮：仅结束，便于断言 lastTurnInput。
    agent.turnImpl = async (_input, handlers) => {
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
    ctx.send({
      type: 'prompt',
      requestId: 'reqA',
      text: '请总结这些文件',
      attachments: [
        { kind: 'file', path: 'src/a.ts' },
        { kind: 'file', path: 'src/b.ts' },
      ],
    })
    await ctx.waitFor('turn_done')
    expect(agent.lastTurnInput).toContain('上下文文件')
    expect(agent.lastTurnInput).toContain('src/a.ts')
    expect(agent.lastTurnInput).toContain('src/b.ts')
    expect(agent.lastTurnInput).toContain('请总结这些文件')
  })
})
