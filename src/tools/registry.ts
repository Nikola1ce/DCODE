// 工具注册表。
// 统一管理内置工具与 MCP 动态工具，供 Agent 查询、过滤与生成 OpenAI function schema。
// 制作人：Moriarty_Dox

import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type { PermissionMode } from '../config.js'
import type { ToolDefinition } from '../core/types.js'

/**
 * 可扩展的工具注册表：内置工具 + MCP 动态工具。
 */
export class ToolRegistry {
  private builtin = new Map<string, ToolDefinition>()
  private mcp = new Map<string, ToolDefinition>()

  /**
   * 注册内置工具（启动时一次性写入）。
   * @param tools 内置工具列表。
   */
  registerBuiltin(tools: ToolDefinition[]): void {
    this.builtin.clear()
    for (const t of tools) this.builtin.set(t.name, t)
  }

  /**
   * 替换式注册 MCP 动态工具。
   * @param tools MCP 工具列表。
   */
  registerMcp(tools: ToolDefinition[]): void {
    this.mcp.clear()
    for (const t of tools) this.mcp.set(t.name, t)
  }

  /**
   * 按名称查找工具（内置优先于 MCP 同名，通常 MCP 使用 mcp__ 前缀不会冲突）。
   * @param name 工具名。
   * @returns 工具定义或 undefined。
   */
  get(name: string): ToolDefinition | undefined {
    return this.builtin.get(name) ?? this.mcp.get(name)
  }

  /**
   * 返回当前权限模式下可用的全部工具。
   * @param permissionMode 权限模式。
   * @returns 工具列表。
   */
  getAvailable(permissionMode: PermissionMode | string): ToolDefinition[] {
    const all = [...this.builtin.values(), ...this.mcp.values()]
    if (permissionMode === 'plan') {
      return all.filter((t) => t.readOnly)
    }
    return all
  }

  /**
   * 将工具列表转为 OpenAI tools schema。
   * @param tools 工具定义列表。
   * @returns ChatCompletionTool 数组。
   */
  toOpenAISchema(tools: ToolDefinition[]): ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }

  /**
   * 内置工具数量。
   * @returns 数量。
   */
  get builtinCount(): number {
    return this.builtin.size
  }

  /**
   * MCP 工具数量。
   * @returns 数量。
   */
  get mcpCount(): number {
    return this.mcp.size
  }
}

/** 全局单例注册表。 */
export const globalToolRegistry = new ToolRegistry()

/**
 * 替换注册 MCP Server 提供的动态工具。
 * @param tools MCP 工具定义列表。
 */
export function registerMcpTools(tools: ToolDefinition[]): void {
  globalToolRegistry.registerMcp(tools)
}
