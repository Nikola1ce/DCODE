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
  onToolStart?: (info: { id: string; name: string; summary: string }) => void
  onToolProgress?: (info: { id: string; text: string }) => void
  onToolEnd?: (info: { id: string; name: string; result: ToolResult; durationMs: number }) => void
}

export interface ExecuteToolBatchOptions {
  toolCalls: ToolCall[]
  availableTools: ToolDefinition[]
  baseCtx: ToolContext
  abortSignal: AbortSignal
  callbacks?: ToolSchedulerCallbacks
}

/**
 * 执行一批工具调用，返回顺序与模型发起顺序一致。
 */
export async function executeToolBatch(
  opts: ExecuteToolBatchOptions,
): Promise<ScheduledToolResult[]> {
  const results: ScheduledToolResult[] = new Array(opts.toolCalls.length)
  const filePathLocks = new Map<string, Promise<void>>()

  let i = 0
  while (i < opts.toolCalls.length) {
    const first = opts.toolCalls[i]
    if (isParallelSafeCall(first, opts.availableTools)) {
      const group: Array<{ call: ToolCall; index: number }> = []
      while (
        i < opts.toolCalls.length &&
        isParallelSafeCall(opts.toolCalls[i], opts.availableTools)
      ) {
        group.push({ call: opts.toolCalls[i], index: i })
        i++
      }
      const groupResults = await Promise.all(
        group.map(({ call, index }) =>
          executeOne(call, opts, filePathLocks).then((executed) => ({
            index,
            value: executed,
          })),
        ),
      )
      for (const r of groupResults) results[r.index] = r.value
      continue
    }

    results[i] = await executeOne(first, opts, filePathLocks)
    i++
  }

  return results
}

function isParallelSafeCall(call: ToolCall, tools: ToolDefinition[]): boolean {
  const tool = tools.find((t) => t.name === call.name)
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

    const tool = opts.availableTools.find((t) => t.name === call.name)
    const summary = renderToolSummary(tool, call)
    opts.callbacks?.onToolStart?.({ id: call.id, name: call.name, summary })

    const startedAt = Date.now()
    const localCtx: ToolContext = {
      ...opts.baseCtx,
      onProgress: (text) =>
        opts.callbacks?.onToolProgress?.({ id: call.id, text }),
    }

    const executed = await executeToolCall(call, localCtx)
    opts.callbacks?.onToolEnd?.({
      id: call.id,
      name: call.name,
      result: executed.result,
      durationMs: Date.now() - startedAt,
    })
    return { call, executed }
  })
}

function renderToolSummary(
  tool: ToolDefinition | undefined,
  call: ToolCall,
): string {
  try {
    const parsed = call.argsJson ? JSON.parse(call.argsJson) : {}
    return tool?.renderCall?.(parsed) ?? call.name
  } catch {
    return call.name
  }
}
