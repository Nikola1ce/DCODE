// IDE v5 桌面协议集成测试：真实 Agent、内存 IPC 与临时会话/检查点，只有 LLM 使用脚本桩。
// 制作人：Moriarty_Dox

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DCodeConfig, PermissionMode } from '../config.js'
import { Agent } from '../core/agent.js'
import { listCheckpointSummaries } from '../core/checkpoint.js'
import { SessionRecorder, getSessionPath, loadSessionSnapshot } from '../core/session.js'
import type { DeepMessage } from '../core/types.js'
import { createLLMClient } from '../providers/factory.js'
import type { LLMClient, StreamChatParams, StreamEvent } from '../providers/types.js'
import { getTool } from '../tools/index.js'
import type { HostToolDeclaration } from './hostTools.js'
import { createLineDecoder, encodeMessage, type ClientMessage, type ServerMessage } from './protocol.js'
import { IdeServer } from './server.js'

const isolated = vi.hoisted(() => ({ configDir: '' }))
vi.mock('../providers/factory.js', () => ({ createLLMClient: vi.fn() }))
vi.mock('../memory.js', () => ({ loadMemories: () => [], formatMemories: () => '' }))
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return {
    ...actual,
    getConfigDir: () => {
      if (!isolated.configDir) throw new Error('测试配置目录尚未初始化')
      return isolated.configDir
    },
    // 防止未来改动绕过夹具的 applyConfig 而读写用户配置。
    loadConfig: () => { throw new Error('测试禁止读取真实配置') },
    updateConfig: () => { throw new Error('测试禁止写入真实配置') },
  }
})

type Frame<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>

class ScriptedClient implements LLMClient {
  calls: StreamChatParams[] = []
  replies: DeepMessage[] = []
  hold = false

  hasApiKey() { return true }
  getProviderId() { return 'custom' as const }
  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    this.calls.push({ ...params, messages: structuredClone(params.messages) })
    if (this.hold && !params.abortSignal?.aborted) {
      await new Promise<void>((resolve) => params.abortSignal?.addEventListener('abort', () => resolve(), { once: true }))
    }
    if (params.abortSignal?.aborted) {
      const error = new Error('测试请求已取消')
      error.name = 'AbortError'
      throw error
    }
    const message = this.replies.shift()
    if (!message) throw new Error('未配置本次 LLM 响应')
    if (message.reasoning) yield { type: 'reasoning', delta: message.reasoning }
    if (message.content) yield { type: 'text', delta: message.content }
    yield { type: 'done', message: structuredClone(message), finishReason: message.toolCalls?.length ? 'tool_calls' : 'stop' }
  }
}

const privateOutput: DeepMessage['responseOutput'] = [{
  type: 'reasoning', id: 'internal-reasoning', summary: [], encrypted_content: 'PRIVATE_ENCRYPTED_OUTPUT',
}] as DeepMessage['responseOutput']
const hostTool: HostToolDeclaration = {
  name: 'host__desktop_action', description: '测试桌面操作',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  readOnly: false, requiresPermission: true, timeoutMs: 0,
}

let root: string
interface Fixture {
  agent: Agent
  recorder: SessionRecorder
  client: ScriptedClient
  cwd: string
  configPath: string
  applyConfig: any
  run: any
  server: IdeServer
  closed: Promise<void>
  input: PassThrough
  output: PassThrough
  log: PassThrough
  frames: ServerMessage[]
  send: (message: ClientMessage) => void
  all: <T extends ServerMessage['type']>(type: T, requestId?: string) => Array<Extract<ServerMessage, { type: T }>>
  wait: <T extends ServerMessage['type']>(type: T, requestId?: string) => Promise<Extract<ServerMessage, { type: T }>>
}
const fixtures: Fixture[] = []

function setup(options: { cwd?: string; recorder?: SessionRecorder; messages?: DeepMessage[]; permissionMode?: PermissionMode } = {}): Fixture {
  const cwd = options.cwd ?? mkdtempSync(join(root, 'workspace-'))
  const config: DCodeConfig = {
    provider: 'custom', baseURL: 'https://unused.invalid', model: 'desktop-test',
    theme: 'dark', showThinking: true, reasoningEffort: 'high', alwaysAllow: [],
    totalCostUsd: 0, onboardingComplete: true, hooksEnabled: false,
    soundEnabled: false, soundVolume: 0,
  }
  const client = new ScriptedClient()
  vi.mocked(createLLMClient).mockReturnValue(client)
  const recorder = options.recorder ?? SessionRecorder.create(cwd, config.model)
  if (options.messages) recorder.replaceMessages(options.messages)
  const agent = new Agent({
    config, cwd, recorder, initialMessages: recorder.getHistory(),
    permissionMode: options.permissionMode ?? 'acceptEdits',
  })
  const run = vi.spyOn(agent, 'runTurn')
  const input = new PassThrough()
  const output = new PassThrough()
  const log = new PassThrough()
  const frames: ServerMessage[] = []
  const decoder = createLineDecoder<ServerMessage>()
  output.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)))
  const configPath = join(isolated.configDir, `${recorder.id}.json`)
  let stored = { ...config }
  writeFileSync(configPath, JSON.stringify(stored))
  const applyConfig = vi.fn((patch: Partial<DCodeConfig>) => {
    stored = { ...stored, ...patch }
    writeFileSync(configPath, JSON.stringify(stored))
    agent.applyConfigPatch(patch)
  })
  const server = new IdeServer({ agent, config, input, output, log, applyConfig })
  const closed = server.start()
  const send = (message: ClientMessage) => { input.write(encodeMessage(message)) }
  const all = <T extends ServerMessage['type']>(type: T, requestId?: string): Frame<T>[] => frames.filter(
    (frame): frame is Frame<T> => frame.type === type && (requestId === undefined || ('requestId' in frame && frame.requestId === requestId)),
  )
  const wait = async <T extends ServerMessage['type']>(type: T, requestId?: string): Promise<Frame<T>> => {
    await vi.waitFor(() => expect(all(type, requestId).length, `等待 ${type}/${requestId ?? ''}`).toBeGreaterThan(0), { timeout: 3000, interval: 5 })
    return all(type, requestId).at(-1)!
  }
  const fixture = { agent, recorder, client, cwd, configPath, applyConfig, run, server, closed, input, output, log, frames, send, all, wait }
  fixtures.push(fixture)
  return fixture
}

function queueTool(client: ScriptedClient, id: string, name: string, input: unknown) {
  client.replies.push(
    { role: 'assistant', content: '', responseOutput: privateOutput, toolCalls: [{ id, name, argsJson: JSON.stringify(input) }] },
    { role: 'assistant', content: '操作完成', reasoning: '可见推理', responseOutput: privateOutput },
  )
}

async function history(f: ReturnType<typeof setup>, requestId = 'history') {
  f.send({ type: 'request_history', requestId })
  return (await f.wait('history_snapshot', requestId)).messages
}

async function writeTurn(f: ReturnType<typeof setup>, requestId = 'write') {
  const input = { path: 'note.txt', content: 'after\n' }
  writeFileSync(join(f.cwd, input.path), 'before\n')
  queueTool(f.client, 'write-call', 'write_file', input)
  f.send({ type: 'prompt', requestId, text: '更新文件' })
  expect((await f.wait('turn_done', requestId)).reason).toBe('final')
  expect(readFileSync(join(f.cwd, input.path), 'utf8')).toBe(input.content)
  const end = f.all('tool_end', requestId)[0]
  expect(end.isError).toBe(false)
  const checkpointId = end.changedFiles?.[0]?.checkpointId
  expect(checkpointId).toEqual(expect.any(String))
  return { input, checkpointId: checkpointId!, messages: await history(f, `${requestId}-history`) }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dcode-desktop-'))
  isolated.configDir = join(root, 'config')
  mkdirSync(isolated.configDir)
  for (const key of ['DCODE_COMPACT_MAX_TOKENS', 'DCODE_PROVIDER', 'DCODE_MODEL', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ZHIPU_API_KEY']) vi.stubEnv(key, '')
})

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.server.shutdown()
    await f.closed
    await Promise.allSettled((f.run.mock.results as Array<{ type: string; value: unknown }>)
      .filter((result) => result.type === 'return').map((result) => result.value))
    f.input.destroy()
    f.output.destroy()
    f.log.destroy()
  }
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
  isolated.configDir = ''
})

describe('IDE v5 桌面通路（真实 Agent）', () => {
  it('ready 协商能力；旧历史补齐稳定 id，历史投影不泄露 system/responseOutput', async () => {
    const f = setup({ messages: [
      { role: 'system', content: 'PRIVATE_SYSTEM_PROMPT' },
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答', reasoning: '可展示推理', responseOutput: privateOutput },
    ] })
    expect(await f.wait('ready')).toMatchObject({
      protocolVersion: 5, reasoningEffort: 'high', sessionId: f.recorder.id,
      capabilities: {
        reasoningEffort: true, historySnapshot: true, turnMetadata: true,
        structuredPermissions: true, checkpointDiff: true, checkpointUndoById: true,
        hostTools: true, rewind: true, forkSession: true,
      },
    })
    const first = await history(f, 'history-1')
    expect(first.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(first.every((message) => typeof message.id === 'string' && message.id.length > 0)).toBe(true)
    expect(new Set(first.map((message) => message.id)).size).toBe(2)
    expect(await history(f, 'history-2')).toEqual(first)
    expect(first.map((message) => message.id)).toEqual(f.recorder.getHistory().filter((message) => message.role !== 'system').map((message) => message.id))
    expect(JSON.stringify(f.frames)).not.toMatch(/PRIVATE_SYSTEM_PROMPT|responseOutput|PRIVATE_ENCRYPTED_OUTPUT/)
    expect(getSessionPath(f.recorder.id).startsWith(isolated.configDir)).toBe(true)
    expect(f.client.calls).toHaveLength(0)
  })

  it('真实写文件往返携带 turn/assistant 身份、工具 input 和 changedFiles 检查点元数据', async () => {
    const f = setup()
    const { input, checkpointId, messages } = await writeTurn(f)
    const start = f.all('turn_started', 'write')[0]
    expect(start).toMatchObject({ runId: expect.any(String), turnId: expect.any(String), timestamp: expect.any(Number), messageId: messages[0].id })
    expect(f.all('tool_start', 'write')[0]).toMatchObject({ toolCallId: 'write-call', name: 'write_file', input, runId: start.runId, turnId: start.turnId })
    expect(f.all('tool_end', 'write')[0]).toMatchObject({
      changedFiles: [{ path: 'note.txt', operation: 'edit', checkpointId, added: 1, removed: 1 }],
      runId: start.runId, turnId: start.turnId,
    })
    const assistants = f.all('assistant_done', 'write')
    expect(assistants).toHaveLength(2)
    expect(assistants.map((frame) => frame.message)).toEqual(messages.filter((message) => message.role === 'assistant'))
    for (const frame of assistants) {
      expect(frame).toMatchObject({ messageId: frame.message.id, runId: start.runId, turnId: start.turnId })
      expect(frame.message).not.toHaveProperty('responseOutput')
    }
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length)
    expect(messages.every((message) => message.runId === start.runId && message.turnId === start.turnId)).toBe(true)
    expect(f.recorder.getHistory().some((message) => message.responseOutput?.length)).toBe(true)
    expect(JSON.stringify(f.frames)).not.toContain('PRIVATE_ENCRYPTED_OUTPUT')
  })

  it('推理强度合法值持久化并进入真实 LLM 参数，非法值不改配置', async () => {
    const f = setup()
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      f.send({ type: 'set_reasoning_effort', effort })
      expect(f.all('status').at(-1)?.reasoningEffort).toBe(effort)
      expect(f.applyConfig).toHaveBeenLastCalledWith({ reasoningEffort: effort })
      expect(JSON.parse(readFileSync(f.configPath, 'utf8')).reasoningEffort).toBe(effort)
    }
    const count = f.applyConfig.mock.calls.length
    for (const effort of ['ultra', null, 5]) f.input.write(JSON.stringify({ type: 'set_reasoning_effort', effort }) + '\n')
    expect(f.all('log').filter((frame) => frame.level === 'warn')).toHaveLength(3)
    expect(f.applyConfig).toHaveBeenCalledTimes(count)
    f.client.replies.push({ role: 'assistant', content: '完成' })
    f.send({ type: 'prompt', requestId: 'effort', text: '检查参数' })
    await f.wait('turn_done', 'effort')
    expect(f.client.calls[0].reasoningEffort).toBe('max')
  })

  it('宿主注册冲突不破坏旧快照，权限拒绝不调用宿主，允许后工具结果完整回填', async () => {
    const f = setup({ permissionMode: 'default' })
    f.send({ type: 'register_host_tools', requestId: 'register', tools: [hostTool] })
    expect(await f.wait('host_tools_registered', 'register')).toMatchObject({ names: [hostTool.name] })
    const conflicts = [[{ ...hostTool, name: 'write_file' }], [{ ...hostTool, name: 'mcp__test__tool' }], [hostTool, hostTool]]
    for (const [index, tools] of conflicts.entries()) {
      const requestId = `conflict-${index}`
      f.send({ type: 'register_host_tools', requestId, tools })
      expect(await f.wait('operation_error', requestId)).toMatchObject({ operation: 'register_host_tools', message: expect.stringMatching(/冲突|重复/) })
    }
    expect(getTool(hostTool.name)).toBeUndefined()
    const input = { text: '确认中文操作' }
    queueTool(f.client, 'denied-call', hostTool.name, input)
    f.send({ type: 'prompt', requestId: 'denied', text: '执行但拒绝' })
    const denied = await f.wait('permission_request', 'denied')
    expect(denied.request).toMatchObject({
      toolName: hostTool.name, toolCallId: 'denied-call', input,
      details: { kind: 'host', toolName: hostTool.name, input },
    })
    f.send({ type: 'permission_response', permissionId: denied.permissionId, decision: 'deny' })
    await f.wait('turn_done', 'denied')
    expect(f.all('host_tool_call')).toHaveLength(0)
    expect(f.all('tool_end', 'denied')[0].isError).toBe(true)
    expect(f.client.calls[1].messages.find((message) => message.toolCallId === 'denied-call')?.isError).toBe(true)

    queueTool(f.client, 'allowed-call', hostTool.name, input)
    f.send({ type: 'prompt', requestId: 'allowed', text: '执行并允许' })
    const permission = await f.wait('permission_request', 'allowed')
    f.send({ type: 'permission_response', permissionId: permission.permissionId, decision: 'allow_once' })
    const call = await f.wait('host_tool_call', 'allowed')
    expect(call).toMatchObject({ toolCallId: 'allowed-call', name: hostTool.name, input, runId: permission.runId, turnId: permission.turnId })
    const result = { llmContent: '宿主操作成功', uiSummary: '成功', changedFiles: [{ path: 'virtual.txt', operation: 'edit' as const, added: 1, removed: 0 }] }
    f.send({ type: 'host_tool_result', hostCallId: 'unknown-call', result })
    expect(f.all('turn_done', 'allowed')).toHaveLength(0)
    f.send({ type: 'host_tool_result', hostCallId: call.hostCallId, result })
    await f.wait('turn_done', 'allowed')
    expect(f.all('tool_end', 'allowed')[0]).toMatchObject({ isError: false, detail: result.llmContent, changedFiles: result.changedFiles })
    expect(f.client.calls[3].messages.find((message) => message.toolCallId === 'allowed-call')).toMatchObject({ role: 'tool', content: result.llmContent })
    expect(f.client.calls[2].tools.some((tool) => tool.function.name === hostTool.name)).toBe(true)
  })

  it.each([
    ['cancel', false], ['disconnect', false], ['cancel', true], ['disconnect', true],
  ] as const)('%s 结算在途宿主调用/权限（等待权限=%s）且不遗留运行', async (action, waitingPermission) => {
    const f = setup({ permissionMode: 'default' })
    f.send({ type: 'register_host_tools', requestId: 'register', tools: [{ ...hostTool, requiresPermission: waitingPermission }] })
    await f.wait('host_tools_registered', 'register')
    queueTool(f.client, 'pending-call', hostTool.name, { text: '等待' })
    f.send({ type: 'prompt', requestId: 'pending', text: '挂起工具' })
    const pending = waitingPermission ? await f.wait('permission_request', 'pending') : await f.wait('host_tool_call', 'pending')
    if (action === 'cancel') {
      f.send({ type: 'cancel', requestId: 'pending' })
      expect(await f.wait('turn_done', 'pending')).toMatchObject({ reason: 'aborted' })
      if (pending.type === 'host_tool_call') {
        expect(f.all('host_tool_cancel')[0]?.hostCallId).toBe(pending.hostCallId)
        f.send({ type: 'host_tool_result', hostCallId: pending.hostCallId, result: { llmContent: '迟到结果' } })
      } else {
        f.send({ type: 'permission_response', permissionId: pending.permissionId, decision: 'allow_once' })
      }
    } else {
      f.input.end()
      await f.closed
    }
    await f.run.mock.results[0].value
    const toolResult = f.recorder.getHistory().find((message) => message.toolCallId === 'pending-call')
    expect(toolResult).toMatchObject({ role: 'tool', isError: true })
    expect(toolResult?.content).not.toContain('迟到结果')
    expect(f.client.calls).toHaveLength(1)
    if (waitingPermission) expect(f.all('host_tool_call')).toHaveLength(0)
  })

  it('检查点只归属本会话：跨会话 diff/undo 拒绝，本会话 diff 与 undo 真实恢复文件', async () => {
    const f = setup()
    const { checkpointId } = await writeTurn(f)
    f.send({ type: 'request_checkpoints', requestId: 'checkpoints' })
    const checkpoints = (await f.wait('checkpoint_list', 'checkpoints')).checkpoints
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({ id: checkpointId, sessionId: f.recorder.id, toolCallId: 'write-call', complete: true, legacy: false })
    const other = setup({ cwd: f.cwd })
    other.send({ type: 'request_checkpoints', requestId: 'foreign-list' })
    expect((await other.wait('checkpoint_list', 'foreign-list')).checkpoints).toEqual([])
    other.send({ type: 'request_checkpoint_diff', requestId: 'foreign-diff', checkpointId })
    expect((await other.wait('checkpoint_diff', 'foreign-diff')).result).toMatchObject({ ok: false, code: 'session_mismatch' })
    other.send({ type: 'undo_checkpoint', requestId: 'foreign-undo', checkpointId })
    expect((await other.wait('checkpoint_undone', 'foreign-undo')).result).toMatchObject({ ok: false, count: 0, failures: [{ code: 'session_mismatch' }] })
    expect(readFileSync(join(f.cwd, 'note.txt'), 'utf8')).toBe('after\n')

    f.send({ type: 'request_checkpoint_diff', requestId: 'diff', checkpointId })
    const diff = (await f.wait('checkpoint_diff', 'diff')).result
    expect(diff).toMatchObject({ ok: true, added: 1, removed: 1, truncated: false, checkpoint: { id: checkpointId } })
    if (!diff.ok) throw new Error(diff.error)
    expect(diff.preview).toContain('before')
    expect(diff.preview).toContain('after')
    f.send({ type: 'undo_checkpoint', requestId: 'undo', checkpointId })
    expect((await f.wait('checkpoint_undone', 'undo')).result).toMatchObject({ ok: true, count: 1, undoneIds: [checkpointId], failures: [] })
    expect(readFileSync(join(f.cwd, 'note.txt'), 'utf8')).toBe('before\n')
    expect(listCheckpointSummaries(f.cwd, f.recorder.id)).toEqual([])
  })

  it.each(['messages', 'files', 'both'] as const)('rewind %s 按消息边界同步真实 Agent、会话磁盘和文件', async (mode) => {
    const f = setup()
    const { messages } = await writeTurn(f)
    f.send({ type: 'rewind', requestId: 'rewind', messageId: messages[0].id!, mode })
    const result = await f.wait('rewind_result', 'rewind')
    expect(result).toMatchObject({ sessionId: f.recorder.id, mode, removedMessages: mode === 'files' ? 0 : messages.length })
    expect(result.warning).toMatch(/命令.*Git/)
    expect(result.restoredFiles).toHaveLength(mode === 'messages' ? 0 : 1)
    const expected = mode === 'files' ? messages : []
    expect((await f.wait('history_snapshot', 'rewind')).messages).toEqual(expected)
    expect(f.recorder.getHistory().filter((message) => message.role !== 'system').map((message) => message.id)).toEqual(expected.map((message) => message.id))
    expect(f.agent.getMessages().filter((message) => message.role !== 'system').map((message) => message.id)).toEqual(expected.map((message) => message.id))
    expect(readFileSync(join(f.cwd, 'note.txt'), 'utf8')).toBe(mode === 'messages' ? 'after\n' : 'before\n')
    expect(listCheckpointSummaries(f.cwd, f.recorder.id)).toHaveLength(mode === 'messages' ? 1 : 0)
  })

  it('fork 延伸至完整工具链，保留血缘和消息身份但不继承检查点，不切换/改写父会话', async () => {
    const f = setup()
    const { messages, checkpointId } = await writeTurn(f)
    f.send({ type: 'fork_session', requestId: 'fork', messageId: messages.find((message) => message.role === 'assistant')!.id! })
    const fork = await f.wait('session_forked', 'fork')
    expect(fork).toMatchObject({ parentSessionId: f.recorder.id, parentMessageId: messages.at(-1)!.id })
    expect(fork.sessionId).not.toBe(f.recorder.id)
    const snapshot = loadSessionSnapshot(fork.sessionId)
    expect(snapshot.meta).toMatchObject({ parentSessionId: f.recorder.id, parentMessageId: fork.parentMessageId, cwd: f.cwd })
    expect(snapshot.messages.filter((message) => message.role !== 'system').map((message) => message.id)).toEqual(messages.map((message) => message.id))
    expect(f.agent.getSessionId()).toBe(f.recorder.id)
    expect(await history(f, 'parent-after-fork')).toEqual(messages)
    expect(listCheckpointSummaries(f.cwd, fork.sessionId)).toEqual([])
    const child = setup({ cwd: f.cwd, recorder: new SessionRecorder(fork.sessionId) })
    child.send({ type: 'request_checkpoint_diff', requestId: 'child-diff', checkpointId })
    expect((await child.wait('checkpoint_diff', 'child-diff')).result).toMatchObject({ ok: false, code: 'session_mismatch' })
    child.client.replies.push({ role: 'assistant', content: '分支独立继续' })
    child.send({ type: 'prompt', requestId: 'child-turn', text: '仅在分支新增' })
    await child.wait('turn_done', 'child-turn')
    expect((await history(child, 'child-history')).length).toBe(messages.length + 2)
    expect(await history(f, 'parent-unchanged')).toEqual(messages)
  })

  it('运行中拒绝历史变更、宿主注册和配置；仍可查询历史，取消后解除限制', async () => {
    const f = setup()
    f.client.hold = true
    f.send({ type: 'prompt', requestId: 'busy', text: '等待取消' })
    await vi.waitFor(() => expect(f.client.calls).toHaveLength(1), { timeout: 3000, interval: 5 })
    const messages = await history(f, 'busy-history')
    const operations: ClientMessage[] = [
      { type: 'rewind', requestId: 'busy-rewind', messageId: messages[0].id!, mode: 'both' },
      { type: 'fork_session', requestId: 'busy-fork', messageId: messages[0].id! },
      { type: 'undo_checkpoint', requestId: 'busy-undo', checkpointId: 'irrelevant' },
      { type: 'register_host_tools', requestId: 'busy-register', tools: [hostTool] },
    ]
    for (const operation of operations) {
      f.send(operation)
      expect(await f.wait('operation_error', 'requestId' in operation ? operation.requestId : '')).toMatchObject({ operation: operation.type, code: 'busy' })
    }
    const configs: ClientMessage[] = [
      { type: 'set_model', model: 'other-model' }, { type: 'set_provider', provider: 'openai' },
      { type: 'set_reasoning_effort', effort: 'low' }, { type: 'set_permission_mode', mode: 'bypass' },
      { type: 'submit_api_key', provider: 'openai', apiKey: 'test-only-not-a-key' }, { type: 'clear' },
    ]
    for (const message of configs) f.send(message)
    expect(f.all('log').filter((frame) => frame.level === 'warn')).toHaveLength(configs.length)
    expect(f.applyConfig).not.toHaveBeenCalled()
    expect(f.agent.getModel()).toBe('desktop-test')
    expect(f.agent.permissionMode).toBe('acceptEdits')
    expect(await history(f, 'still-busy-history')).toEqual(messages)
    expect(f.all('host_tools_registered')).toHaveLength(0)
    f.send({ type: 'cancel', requestId: 'busy' })
    expect((await f.wait('turn_done', 'busy')).reason).toBe('aborted')
    f.send({ type: 'set_reasoning_effort', effort: 'low' })
    expect(f.all('status').at(-1)?.reasoningEffort).toBe('low')
    expect(f.applyConfig).toHaveBeenCalledTimes(1)
  })
})
