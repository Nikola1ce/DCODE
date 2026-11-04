// Agent 工具批调度器。
// 将模型同一轮发起的 tool_calls 按安全策略分组执行：
//   - 只读 / 明确并行安全的工具可在连续区间内并行；
//   - 文件写入、shell、子代理、状态写入等副作用工具按模型顺序串行；
//   - 同一路径工具仍通过 fileToolLock 做最后防线。

import {
  executeToolCall,
  type ExecutedToolResult,
} from '../tools/index.js'
import { extractFileLockKey, withFilePathLock } from './fileToolLock.js'
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolSafetyPolicy,
} from './types.js'

export interface ScheduledToolResult {
  call: ToolCall
  executed: ExecutedToolResult
}

export interface ToolSchedulerCallbacks {
  onToolStart?: (info: { id: string; name: string; summary: string; input?: unknown }) => void
  onToolProgress?: (info: { id: string; text: string }) => void
  onToolEnd?: (info: { id: string; name: string; result: ToolResult; durationMs: number }) => void
}

export interface ExecuteToolBatchOptions {
  toolCalls: ToolCall[]
  availableTools: ToolDefinition[]
  baseCtx: ToolContext
  abortSignal: AbortSignal
  callbacks?: ToolSchedulerCallbacks
  // 仅解析 availableTools 已允许的名字；用于当前 Agent 的局部工具，不扩大全局工具集。
  resolveTool?: (name: string) => ToolDefinition | undefined
}

/**
 * 执行一批工具调用，返回顺序与模型发起顺序一致。
 */
export async function executeToolBatch(
  opts: ExecuteToolBatchOptions,
): Promise<ScheduledToolResult[]> {
  const results: ScheduledToolResult[] = new Array(opts.toolCalls.length)
  const filePathLocks = new Map<string, Promise<void>>()
  // 固定本批次的定义，安全分组与实际执行必须使用同一份快照。
  const tools = new Map<string, ToolDefinition>()
  for (const available of opts.availableTools) {
    const resolved = opts.resolveTool?.(available.name) ?? available
    if (resolved.name === available.name) tools.set(available.name, resolved)
  }

  let i = 0
  while (i < opts.toolCalls.length) {
    const first = opts.toolCalls[i]
    if (isParallelSafeCall(first, tools)) {
      const group: Array<{ call: ToolCall; index: number }> = []
      while (
        i < opts.toolCalls.length &&
        isParallelSafeCall(opts.toolCalls[i], tools)
      ) {
        group.push({ call: opts.toolCalls[i], index: i })
        i++
      }
      const groupResults = await Promise.all(
        group.map(({ call, index }) =>
          executeOne(call, opts, filePathLocks, tools).then((executed) => ({
            index,
            value: executed,
          })),
        ),
      )
      for (const r of groupResults) results[r.index] = r.value
      continue
    }

    results[i] = await executeOne(first, opts, filePathLocks, tools)
    i++
  }

  return results
}

function isParallelSafeCall(call: ToolCall, tools: Map<string, ToolDefinition>): boolean {
  const tool = tools.get(call.name)
  const policy = getToolSafetyPolicy(tool)
  if (policy.parallelSafe === false) return false
  return policy.sideEffect === 'none' || policy.sideEffect === 'network'
}

function getToolSafetyPolicy(tool: ToolDefinition | undefined): ToolSafetyPolicy {
  if (tool?.safety) return tool.safety
  if (tool?.readOnly) return { sideEffect: 'none', parallelSafe: true }
  return { sideEffect: 'state', parallelSafe: false }
}

async function executeOne(
  call: ToolCall,
  opts: ExecuteToolBatchOptions,
  filePathLocks: Map<string, Promise<void>>,
  tools: Map<string, ToolDefinition>,
): Promise<ScheduledToolResult> {
  return withFilePathLock(filePathLocks, extractFileLockKey(call), async () => {
    if (opts.abortSignal.aborted) {
      return {
        call,
        executed: {
          toolCallId: call.id,
          toolName: call.name,
          result: {
            llmContent: '操作已取消。',
            isError: true,
          },
        } as ExecutedToolResult,
      }
    }

    const tool = tools.get(call.name)
    const info = describeToolCall(tool, call)
    opts.callbacks?.onToolStart?.({ id: call.id, name: call.name, ...info })

    const startedAt = Date.now()
    const localCtx: ToolContext = {
      ...opts.baseCtx,
      toolCallId: call.id,
      abortSignal: opts.abortSignal,
      onProgress: (text) =>
        opts.callbacks?.onToolProgress?.({ id: call.id, text }),
    }

    // 工具集合也是执行边界，不能仅用于生成 schema / 决定并行策略。
    const executed: ExecutedToolResult = tool
      ? await executeToolCall(call, localCtx, tool)
      : { toolCallId: call.id, toolName: call.name, result: {
        llmContent: `错误：工具 "${call.name}" 在当前运行中不可用。请只使用已提供的工具。`,
        isError: true,
      } }
    opts.callbacks?.onToolEnd?.({
      id: call.id,
      name: call.name,
      result: executed.result,
      durationMs: Date.now() - startedAt,
    })
    return { call, executed }
  })
}

function describeToolCall(
  tool: ToolDefinition | undefined,
  call: ToolCall,
): { summary: string; input?: unknown } {
  let input: unknown
  try {
    input = call.argsJson ? JSON.parse(call.argsJson) : {}
  } catch {
    return { summary: call.name }
  }
  try {
    return { summary: tool?.renderCall?.(input) ?? call.name, input }
  } catch {
    return { summary: call.name, input }
  }
}
