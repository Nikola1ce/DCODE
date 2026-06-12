// 工具注册表。
// 汇总所有内置工具，提供：按名查找、生成给模型的 function schema、解析与执行调用等能力。
// Agent 主循环只与本模块打交道，无需关心单个工具的实现细节。
// 制作人：Moriarty_Dox

import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type {
  PermissionDecision,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../core/types.js'
import { editFileTool } from './editFile.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { listDirTool } from './listDir.js'
import { MCP_PROXY_TOOLS } from './mcpProxy.js'
import { readFileTool } from './readFile.js'
import { globalToolRegistry, registerMcpTools } from './registry.js'
import { runCommandTool } from './runCommand.js'
import { taskTool } from './task.js'
import { todoWriteTool } from './todo.js'
import { writeFileTool } from './writeFile.js'

// 子代理不可使用的工具名（防止递归 spawn）。
const SUBAGENT_EXCLUDED_TOOLS = new Set(['task'])

// 全部内置工具（顺序影响在 /help 等处的展示顺序；不含 MCP 动态工具）。
export const ALL_TOOLS: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
  runCommandTool,
  todoWriteTool,
  taskTool,
  ...MCP_PROXY_TOOLS,
]

// 初始化全局注册表：内置 + MCP 代理工具（MCP 动态工具由 initMcp 注入）。
globalToolRegistry.registerBuiltin(ALL_TOOLS)

export { registerMcpTools }

/**
 * 按名称获取工具定义。
 * @param name 工具名。
 * @returns 工具定义或 undefined。
 */
export function getTool(name: string): ToolDefinition | undefined {
  return globalToolRegistry.get(name)
}

/**
 * 根据当前权限模式返回模型可用的工具集合。
 * plan（只读规划）模式下过滤掉所有写操作工具，从源头杜绝副作用。
 * @param permissionMode 当前权限模式。
 * @returns 过滤后的工具列表。
 */
export function getAvailableTools(permissionMode: string): ToolDefinition[] {
  return globalToolRegistry.getAvailable(permissionMode)
}

/**
 * 返回子代理可用的工具集合（排除 task 以防递归）。
 * @param permissionMode 当前权限模式。
 * @returns 过滤后的工具列表。
 */
export function getSubAgentTools(permissionMode: string): ToolDefinition[] {
  return getAvailableTools(permissionMode).filter((t) => !SUBAGENT_EXCLUDED_TOOLS.has(t.name))
}

/**
 * 将工具定义转换为 OpenAI function-calling 的 tools 数组。
 * @param tools 工具定义列表。
 * @returns OpenAI tools schema 数组。
 */
export function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return globalToolRegistry.toOpenAISchema(tools)
}

// 执行单次工具调用的结果（含 UI 所需的元信息）。
export interface ExecutedToolResult {
  // 对应的工具调用 id。
  toolCallId: string
  // 工具名。
  toolName: string
  // 工具结果。
  result: ToolResult
}

/**
 * 解析并执行一次工具调用：校验工具存在、解析 JSON 入参、做权限门控、最终执行。
 * 任何阶段出错都会被捕获并转成 isError 结果，保证主循环不中断。
 * @param call 模型发起的工具调用。
 * @param ctx 工具运行上下文。
 * @returns 执行结果。
 */
export async function executeToolCall(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ExecutedToolResult> {
  const tool = getTool(call.name)
  // 未知工具：直接返回错误，提示模型使用已注册工具。
  if (!tool) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      result: {
        llmContent: `错误：未知工具 "${call.name}"。请只使用已提供的工具。`,
        isError: true,
      },
    }
  }

  // 解析入参 JSON。
  let input: any
  try {
    input = call.argsJson ? JSON.parse(call.argsJson) : {}
  } catch (e: any) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      result: {
        llmContent: `错误：工具入参不是合法 JSON：${e.message}`,
        isError: true,
      },
    }
  }

  // plan 模式下禁止写操作工具（双保险，即使被模型调用也拦截）。
  if (ctx.permissionMode === 'plan' && !tool.readOnly) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      result: {
        llmContent: `当前处于「规划模式」，禁止执行写操作（${call.name}）。请先退出规划模式。`,
        isError: true,
      },
    }
  }

  // 权限门控：若工具声明需要授权，则发起权限请求。
  try {
    const permReq = tool.checkPermission?.(input, ctx) ?? null
    if (permReq) {
      const decision: PermissionDecision = await ctx.requestPermission(permReq)
      if (decision === 'deny') {
        return {
          toolCallId: call.id,
          toolName: call.name,
          result: {
            llmContent: `用户拒绝了该操作（${call.name}）。请考虑其他方案或询问用户。`,
            isError: true,
          },
        }
      }
      // allow_once / allow_always 均放行；白名单的持久化在权限回调内部处理。
    }
  } catch (e: any) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      result: { llmContent: `权限检查出错：${e.message}`, isError: true },
    }
  }

  // 真正执行工具，捕获运行期异常。
  try {
    const result = await tool.run(input, ctx)
    return { toolCallId: call.id, toolName: call.name, result }
  } catch (e: any) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      result: { llmContent: `工具执行出错：${e.message}`, isError: true },
    }
  }
}
