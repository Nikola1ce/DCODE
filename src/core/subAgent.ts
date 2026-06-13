// 子代理（SubAgent）并发调度器。
// 负责将 Task 工具发起的子任务委托给独立 Agent 实例执行：隔离上下文、限制并发、
// 按 subagent_type 注入专用系统提示，并汇总结果回传主 Agent。
// 制作人：Moriarty_Dox

import { randomUUID } from 'node:crypto'
import {
  MAX_CONCURRENT_SUBAGENTS,
  MAX_SUBAGENT_ITERATIONS,
  SUBAGENT_TYPES,
  type SubAgentType,
} from '../constants.js'
import type { DCodeConfig } from '../config.js'
import {
  getActiveProviderId,
  getProviderDefinition,
  isModelAllowedForProvider,
} from '../providers/registry.js'
import type { DeepMessage, ToolContext } from './types.js'
import { getSubAgentTools } from '../tools/index.js'
import { createLLMClient } from '../providers/factory.js'
import { buildSystemPrompt } from './systemPrompt.js'
import { accumulateUsage } from '../deepseek/pricing.js'
import type { UsageTotals } from '../deepseek/pricing.js'
import { emptyUsageTotals } from '../deepseek/pricing.js'
import { AgentRunner } from './agentRunner.js'

/** 子代理运行状态。 */
export type SubAgentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** 子代理运行记录（供 /subagents 与 Task 工具查询）。 */
export interface SubAgentRecord {
  /** 子代理唯一 id。 */
  id: string
  /** UI 展示用短标题。 */
  description: string
  /** 子代理类型。 */
  subagentType: SubAgentType
  /** 实际使用的模型。 */
  model: string
  /** 当前状态。 */
  status: SubAgentStatus
  /** 创建时间戳（毫秒）。 */
  createdAt: number
  /** 开始执行时间戳（毫秒）。 */
  startedAt?: number
  /** 结束时间戳（毫秒）。 */
  endedAt?: number
  /** 完成后的文本结果（供主 Agent 消费）。 */
  result?: string
  /** 失败时的错误信息。 */
  error?: string
  /** 是否在后台运行。 */
  background: boolean
}

/** 启动子代理的入参。 */
export interface SubAgentRunOptions {
  /** 子任务描述（必填）。 */
  prompt: string
  /** UI 展示用短标题。 */
  description: string
  /** 子代理类型，默认 generalPurpose。 */
  subagentType?: SubAgentType
  /** 覆盖模型（可选，未指定则用父 Agent 模型或 flash 默认）。 */
  model?: string
  /** 强制只读模式（仅允许读/检索工具）。 */
  readonly?: boolean
  /** 后台运行：立即返回 id，结果稍后通过 /subagents 或再次 Task(resume) 获取。 */
  runInBackground?: boolean
  /** 父级工具上下文（继承 cwd、config、权限回调）。 */
  parentCtx: ToolContext
  /** 取消信号。 */
  abortSignal: AbortSignal
  /** 进度回调（转发到 Task 工具的 onProgress）。 */
  onProgress?: (text: string) => void
}

/**
 * 子代理管理器：维护运行队列、并发信号量与历史记录。
 * 全局单例，供 Task 工具与 /subagents 命令共享。
 */
class SubAgentManager {
  private records = new Map<string, SubAgentRecord>()
  /** 当前正在运行的子代理数量。 */
  private runningCount = 0
  /** 等待槽位的 Promise 解析器队列。 */
  private waitQueue: Array<() => void> = []

  /**
   * 获取全部子代理记录（按创建时间倒序）。
   * @returns 记录数组副本。
   */
  getAllRecords(): SubAgentRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 按 id 查找子代理记录。
   * @param id 子代理 id。
   * @returns 记录或 undefined。
   */
  getRecord(id: string): SubAgentRecord | undefined {
    return this.records.get(id)
  }

  /**
   * 当前运行中的子代理数量。
   * @returns 数量。
   */
  getRunningCount(): number {
    return this.runningCount
  }

  /**
   * 等待并发槽位；达到上限时阻塞直到有子代理完成。
   * @param signal 取消信号。
   */
  private async acquireSlot(signal: AbortSignal): Promise<void> {
    if (this.runningCount < MAX_CONCURRENT_SUBAGENTS) {
      this.runningCount++
      return
    }
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('子代理已取消'))
        return
      }
      const onAbort = () => {
        const idx = this.waitQueue.indexOf(resolve)
        if (idx >= 0) this.waitQueue.splice(idx, 1)
        reject(new Error('子代理已取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waitQueue.push(() => {
        signal.removeEventListener('abort', onAbort)
        this.runningCount++
        resolve()
      })
    })
  }

  /** 释放并发槽位，唤醒下一个等待者。 */
  private releaseSlot(): void {
    this.runningCount = Math.max(0, this.runningCount - 1)
    const next = this.waitQueue.shift()
    if (next) next()
  }

  /**
   * 启动子代理：同步或后台模式。
   * @param opts 运行选项。
   * @returns 子代理 id 与（前台模式下）执行结果。
   */
  async run(opts: SubAgentRunOptions): Promise<{ id: string; result: string; isError: boolean }> {
    const id = randomUUID().slice(0, 8)
    const subagentType = opts.subagentType ?? 'generalPurpose'
    const typeDef = SUBAGENT_TYPES[subagentType]
    const model = resolveSubAgentModel(opts.model, opts.parentCtx.config)

    const record: SubAgentRecord = {
      id,
      description: opts.description,
      subagentType,
      model,
      status: 'queued',
      createdAt: Date.now(),
      background: opts.runInBackground ?? false,
    }
    this.records.set(id, record)

    // 限制历史记录数量，避免内存无限增长。
    if (this.records.size > 100) {
      const oldest = [...this.records.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (oldest) this.records.delete(oldest[0])
    }

    const execute = async (): Promise<{ result: string; isError: boolean }> => {
      await this.acquireSlot(opts.abortSignal)
      record.status = 'running'
      record.startedAt = Date.now()
      opts.onProgress?.(`[子代理 ${id}] 开始执行（${subagentType}，${model}）\n`)

      try {
        const result = await runSubAgentLoop({
          id,
          prompt: opts.prompt,
          subagentType,
          typePrompt: typeDef.systemPrompt,
          model,
          readonly: opts.readonly ?? typeDef.readonlyDefault,
          parentCtx: opts.parentCtx,
          abortSignal: opts.abortSignal,
          onProgress: opts.onProgress,
        })
        record.status = 'completed'
        record.result = result.text
        record.endedAt = Date.now()
        return { result: result.text, isError: result.isError }
      } catch (e: any) {
        record.status = opts.abortSignal.aborted ? 'cancelled' : 'failed'
        record.error = e?.message ?? String(e)
        record.endedAt = Date.now()
        return {
          result: `子代理执行失败：${record.error}`,
          isError: true,
        }
      } finally {
        this.releaseSlot()
      }
    }

    if (opts.runInBackground) {
      // 后台模式：立即返回 id，结果异步写入 record。
      void execute()
      return {
        id,
        result:
          `子代理已在后台启动。\n` +
          `- id: ${id}\n` +
          `- 类型: ${subagentType}\n` +
          `- 模型: ${model}\n` +
          `使用 /subagents 查看状态，或在任务完成后再次查询。`,
        isError: false,
      }
    }

    const { result, isError } = await execute()
    return { id, result, isError }
  }

  /**
   * 查询后台子代理结果；若仍在运行则返回状态提示。
   * @param id 子代理 id。
   * @returns 结果文本或状态说明。
   */
  pollResult(id: string): { result: string; isError: boolean; done: boolean } {
    const record = this.records.get(id)
    if (!record) {
      return { result: `未找到子代理 id: ${id}`, isError: true, done: true }
    }
    if (record.status === 'completed' && record.result !== undefined) {
      return { result: record.result, isError: false, done: true }
    }
    if (record.status === 'failed' || record.status === 'cancelled') {
      return {
        result: record.error ?? `子代理 ${record.status}`,
        isError: true,
        done: true,
      }
    }
    return {
      result: `子代理 ${id} 仍在${record.status === 'queued' ? '排队' : '运行'}中（${record.description}）`,
      isError: false,
      done: false,
    }
  }
}

/** 全局子代理管理器单例。 */
export const subAgentManager = new SubAgentManager()

/**
 * 解析子代理实际使用的模型名。
 * @param override 用户指定的模型覆盖。
 * @param config 父级配置。
 * @returns 合法模型名。
 */
function resolveSubAgentModel(override: string | undefined, config: DCodeConfig): string {
  if (override && isModelAllowedForProvider(override, config)) return override
  if (isModelAllowedForProvider(config.model, config)) return config.model
  return getProviderDefinition(getActiveProviderId(config)).defaultModel
}

/** 子代理主循环的内部参数。 */
interface SubAgentLoopOptions {
  id: string
  prompt: string
  subagentType: SubAgentType
  typePrompt: string
  model: string
  readonly: boolean
  parentCtx: ToolContext
  abortSignal: AbortSignal
  onProgress?: (text: string) => void
}

/**
 * 在隔离上下文中运行子代理主循环（精简版 Agent 循环，不含 Task 工具以防递归）。
 * @param opts 循环参数。
 * @returns 最终文本与是否错误。
 */
async function runSubAgentLoop(opts: SubAgentLoopOptions): Promise<{ text: string; isError: boolean }> {
  const permissionMode = opts.readonly ? 'plan' : opts.parentCtx.permissionMode
  const config: DCodeConfig = { ...opts.parentCtx.config, model: opts.model }

  // 构建子代理专用 system 提示：基础环境 + 类型专用指令。
  // 继承父上下文的额外授权目录，使子代理也能访问 /add-dir 添加的目录。
  const basePrompt = buildSystemPrompt({
    cwd: opts.parentCtx.cwd,
    model: opts.model,
    permissionMode,
    extraDirs: opts.parentCtx.extraDirs,
  })
  const systemContent =
    `${basePrompt}\n\n# 子代理模式\n` +
    `你正在作为子代理（id: ${opts.id}，类型: ${opts.subagentType}）执行一项独立子任务。\n` +
    `父 Agent 无法看到你的工具调用过程，只会收到你的最终文字总结。\n` +
    `请高效完成任务，最后用清晰的中文总结关键发现与结论；不要提及子代理机制本身。\n\n` +
    `# 子代理类型指令\n${opts.typePrompt}`

  const messages: DeepMessage[] = [
    { role: 'system', content: systemContent },
  ]

  const client = createLLMClient(config)
  let usage: UsageTotals = emptyUsageTotals()
  let liveAssistantText = ''
  let finalText = ''
  let maxIterationsHit = false

  const runner = new AgentRunner({
    client,
    config,
    cwd: opts.parentCtx.cwd,
    extraDirs: opts.parentCtx.extraDirs,
    permissionMode,
    model: opts.model,
    userInput: opts.prompt,
    abortSignal: opts.abortSignal,
    requestPermission: opts.parentCtx.requestPermission,
    getMessages: () => messages,
    setMessages: (next) => {
      messages.splice(0, messages.length, ...next)
    },
    appendMessage: (message) => {
      messages.push(message)
    },
    getTodos: () => [],
    setTodos: () => {},
    getAvailableTools: () => getSubAgentTools(permissionMode),
    maxIterations: MAX_SUBAGENT_ITERATIONS,
  })

  for await (const event of runner.run()) {
    if (event.type === 'text_delta') {
      liveAssistantText += event.delta
      opts.onProgress?.(event.delta)
    } else if (event.type === 'llm_done' && event.usage) {
      usage = accumulateUsage(usage, opts.model, event.usage, client.getProviderId())
    } else if (event.type === 'assistant_message') {
      const toolCalls = event.message.toolCalls ?? []
      if (toolCalls.length === 0) {
        finalText = event.message.content || liveAssistantText
      }
      liveAssistantText = ''
    } else if (event.type === 'tool_start') {
      opts.onProgress?.(`\n[工具 ${event.name}] ${event.summary}\n`)
    } else if (event.type === 'tool_progress') {
      opts.onProgress?.(`[工具] ${event.text}`)
    } else if (event.type === 'tool_end') {
      const status = event.result.isError ? '失败' : '完成'
      opts.onProgress?.(`\n[工具 ${event.name} ${status}]\n`)
    } else if (event.type === 'run_end') {
      maxIterationsHit = event.reason === 'max_iterations'
    }
  }

  if (opts.abortSignal.aborted) {
    return { text: '子代理已被取消。', isError: true }
  }

  const costNote = usage.costUsd > 0
    ? `\n\n[子代理用量：${usage.inputTokens}+${usage.outputTokens} tokens，约 $${usage.costUsd.toFixed(4)}]`
    : ''
  if (maxIterationsHit) {
    return {
      text: `[子代理达到最大迭代次数（${MAX_SUBAGENT_ITERATIONS}），已停止。部分结果：]\n${finalText || liveAssistantText}${costNote}`,
      isError: true,
    }
  }
  return { text: (finalText || liveAssistantText || '子代理未收到模型响应。') + costNote, isError: !finalText }
}

/**
 * 渲染 /subagents 命令的状态文本。
 * @returns 多行状态报告。
 */
export function renderSubAgentsStatus(): string {
  const records = subAgentManager.getAllRecords()
  const running = subAgentManager.getRunningCount()
  if (records.length === 0) {
    return `当前无子代理记录。\n并发上限：${MAX_CONCURRENT_SUBAGENTS}`
  }
  const lines = records.slice(0, 20).map((r) => {
    const dur =
      r.endedAt && r.startedAt
        ? `${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s`
        : r.startedAt
          ? `${((Date.now() - r.startedAt) / 1000).toFixed(1)}s…`
          : '-'
    return (
      `  ${r.id}  [${r.status.padEnd(9)}] ${r.subagentType.padEnd(15)} ${r.model}\n` +
      `         ${r.description} (${dur})`
    )
  })
  return [
    `子代理状态（运行中 ${running}/${MAX_CONCURRENT_SUBAGENTS}，最近 ${records.length} 条）：`,
    ...lines,
    records.length > 20 ? `  … 另有 ${records.length - 20} 条历史记录` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
