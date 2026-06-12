// Task 子代理工具。
// 允许主 Agent 将独立子任务委托给子代理并行执行；支持类型、模型、只读与后台模式。
// 子代理拥有隔离上下文，不含 Task 工具以防递归；结果汇总后回传主 Agent。
// 制作人：Moriarty_Dox

import {
  SUBAGENT_TYPE_NAMES,
  SUBAGENT_TYPES,
  isValidSubAgentType,
  type SubAgentType,
} from '../constants.js'
import { isModelAllowedForProvider } from '../providers/registry.js'
import { subAgentManager } from '../core/subAgent.js'
import type { PermissionRequest, ToolDefinition, ToolResult } from '../core/types.js'

/** Task 工具入参。 */
interface TaskInput {
  /** 子任务详细描述（必填）。 */
  prompt: string
  /** UI 展示用短标题（5–10 字）。 */
  description: string
  /** 子代理类型。 */
  subagent_type?: SubAgentType
  /** 覆盖模型（如 deepseek-v4-flash 节省成本）。 */
  model?: string
  /** 强制只读模式。 */
  readonly?: boolean
  /** 后台运行，立即返回子代理 id。 */
  run_in_background?: boolean
  /** 查询已有后台子代理 id 的结果（resume 模式）。 */
  resume?: string
}

export const taskTool: ToolDefinition = {
  name: 'task',
  description:
    '将子任务委托给独立子代理执行。子代理拥有隔离上下文，可并行处理探索、命令、编码等子任务。' +
    '适合：并行搜索多个目录、独立 git/构建操作、大型代码库探索。' +
    '同一轮可多次调用 task 实现并行；默认最多同时运行 5 个子代理。' +
    'subagent_type：generalPurpose（通用）、explore（只读探索）、shell（命令执行）。' +
    '可指定 model 降级为 flash 节省成本；run_in_background=true 时后台运行并用 resume 查询结果。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: '子任务短标题（5-10 字），供 UI 展示',
      },
      prompt: {
        type: 'string',
        description: '子任务的完整描述与预期产出',
      },
      subagent_type: {
        type: 'string',
        enum: [...SUBAGENT_TYPE_NAMES],
        description: '子代理类型：generalPurpose | explore | shell',
      },
      model: {
        type: 'string',
        description: '可选：覆盖子代理使用的模型（如 deepseek-v4-flash）',
      },
      readonly: {
        type: 'boolean',
        description: '可选：强制只读模式（仅 read/grep/glob/list_dir）',
      },
      run_in_background: {
        type: 'boolean',
        description: '可选：后台运行，立即返回子代理 id',
      },
      resume: {
        type: 'string',
        description: '可选：查询已有后台子代理 id 的执行结果',
      },
    },
    required: ['description', 'prompt'],
  },
  renderCall: (input: TaskInput) => {
    if (input.resume) return `查询子代理 ${input.resume}`
    const type = input.subagent_type ?? 'generalPurpose'
    return `子代理: ${input.description} (${type})`
  },
  /**
   * 启动具 shell/写能力的子代理前需用户确认（只读 explore 除外）。
   * @param input 入参。
   * @param ctx 运行上下文。
   */
  checkPermission: (input: TaskInput, ctx): PermissionRequest | null => {
    if (input.resume?.trim()) return null
    if (ctx.permissionMode === 'bypass' || ctx.permissionMode === 'acceptEdits') return null
    const type = input.subagent_type ?? 'generalPurpose'
    if (input.readonly || SUBAGENT_TYPES[type]?.readonlyDefault) return null
    return {
      toolName: 'task',
      title: `启动子代理：${input.description}`,
      preview: input.prompt?.slice(0, 300),
      ruleKey: `task(${type})`,
    }
  },
  /**
   * 执行 Task：resume 查询或启动新子代理。
   * @param input 入参。
   * @param ctx 父级工具上下文。
   * @returns 子代理结果。
   */
  run: async (input: TaskInput, ctx): Promise<ToolResult> => {
    // resume 模式：轮询已有后台子代理结果。
    if (input.resume?.trim()) {
      const polled = subAgentManager.pollResult(input.resume.trim())
      return {
        llmContent: polled.result,
        uiSummary: polled.done ? `子代理 ${input.resume} 已完成` : `子代理 ${input.resume} 运行中`,
        isError: polled.isError,
      }
    }

    if (!input.prompt?.trim()) {
      return { llmContent: '错误：prompt 不能为空。', isError: true }
    }
    if (!input.description?.trim()) {
      return { llmContent: '错误：description 不能为空。', isError: true }
    }

    if (input.subagent_type && !isValidSubAgentType(input.subagent_type)) {
      return {
        llmContent: `错误：无效的 subagent_type "${input.subagent_type}"，可用：${SUBAGENT_TYPE_NAMES.join('、')}`,
        isError: true,
      }
    }

    if (input.model && !isModelAllowedForProvider(input.model, ctx.config)) {
      return {
        llmContent: `错误：不支持的模型 "${input.model}"`,
        isError: true,
      }
    }

    const { id, result, isError } = await subAgentManager.run({
      prompt: input.prompt.trim(),
      description: input.description.trim(),
      subagentType: input.subagent_type,
      model: input.model,
      readonly: input.readonly,
      runInBackground: input.run_in_background,
      parentCtx: ctx,
      abortSignal: ctx.abortSignal,
      onProgress: ctx.onProgress,
    })

    const prefix = input.run_in_background ? '' : `子代理 ${id} 完成。\n\n`
    return {
      llmContent: prefix + result,
      uiSummary: `子代理 ${id}: ${input.description}`,
      isError,
    }
  },
}
