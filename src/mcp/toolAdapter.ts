// MCP Tool 适配器。
// 将 MCP Server 提供的 tool 定义转换为 DCODE ToolDefinition，并生成唯一注册名。
// 制作人：Moriarty_Dox

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDefinition, ToolContext, ToolResult } from '../core/types.js'
import type { McpToolMeta } from './types.js'

/** MCP 工具执行回调类型。 */
export type McpToolCallFn = (
  serverId: string,
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolResult>

/**
 * 将 server id / 工具名中的非法字符替换为下划线，保证 function name 合法。
 * @param value 原始片段。
 * @returns 安全片段。
 */
export function sanitizeMcpSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * 生成 MCP 动态工具在 ToolRegistry 中的唯一名称。
 * @param serverId 配置中的 server id。
 * @param toolName MCP 原始工具名。
 * @returns 形如 mcp__godot__run_project 的名称。
 */
export function formatMcpToolName(serverId: string, toolName: string): string {
  return `mcp__${sanitizeMcpSegment(serverId)}__${sanitizeMcpSegment(toolName)}`
}

/**
 * 从注册名解析 server id 与原始工具名。
 * @param registeredName formatMcpToolName 生成的名称。
 * @returns 解析结果；格式不符时返回 null。
 */
export function parseMcpToolName(
  registeredName: string,
): { serverId: string; toolName: string } | null {
  if (!registeredName.startsWith('mcp__')) return null
  const rest = registeredName.slice('mcp__'.length)
  const idx = rest.indexOf('__')
  if (idx <= 0) return null
  return {
    serverId: rest.slice(0, idx),
    toolName: rest.slice(idx + 2),
  }
}

/**
 * 将 MCP SDK Tool 转为 DCODE ToolDefinition。
 * @param manager MCP 管理器（执行 callTool）。
 * @param serverId server id。
 * @param tool MCP 工具定义。
 * @param trust 是否信任该 server（跳过写操作授权）。
 * @returns ToolDefinition 与元信息。
 */
export function mcpToolToDefinition(
  serverId: string,
  tool: Tool,
  trust: boolean,
  callTool: McpToolCallFn,
): { definition: ToolDefinition; meta: McpToolMeta } {
  const registeredName = formatMcpToolName(serverId, tool.name)
  // readOnlyHint 仅用于 UI/plan 模式提示，不可作为跳过用户授权的依据。
  const readOnlyHint = tool.annotations?.readOnlyHint === true
  const meta: McpToolMeta = {
    serverId,
    originalName: tool.name,
    readOnly: readOnlyHint,
    trust,
  }

  const definition: ToolDefinition = {
    name: registeredName,
    description:
      `[MCP:${serverId}] ${tool.description ?? tool.title ?? tool.name}`,
    readOnly: readOnlyHint,
    safety: readOnlyHint
      ? { sideEffect: 'network', parallelSafe: true }
      : { sideEffect: 'state', parallelSafe: false },
    parameters: (tool.inputSchema as Record<string, unknown>) ?? {
      type: 'object',
      properties: {},
    },
    renderCall: () => `MCP ${serverId}/${tool.name}`,
    checkPermission: (_input, _ctx) => {
      // 仅 server 配置 trust:true 时跳过授权；不信任 MCP 自报的 readOnlyHint。
      if (trust) return null
      return {
        toolName: registeredName,
        title: `MCP 工具 ${serverId}/${tool.name}`,
        ruleKey: `MCP(${serverId}/${tool.name})`,
      }
    },
    run: async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      if (ctx.abortSignal.aborted) {
        return { llmContent: '已取消 MCP 工具调用', isError: true }
      }
      return callTool(serverId, tool.name, input)
    },
  }

  return { definition, meta }
}

/**
 * 将 CallTool 结果中的 content 数组格式化为纯文本。
 * @param content MCP content 数组。
 * @returns 合并后的文本。
 */
export function formatMcpToolContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  }
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const block = item as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'resource' && block.resource) {
      parts.push(JSON.stringify(block.resource, null, 2))
    } else {
      parts.push(JSON.stringify(block, null, 2))
    }
  }
  return parts.join('\n\n') || '(无内容)'
}

/**
 * 将 getPrompt 返回的 messages 格式化为文本。
 * @param messages prompt messages。
 * @returns 合并文本。
 */
export function formatMcpPromptMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return String(messages ?? '')
  const parts: string[] = []
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as { role?: string; content?: unknown }
    const role = m.role ?? 'unknown'
    if (m.content && typeof m.content === 'object') {
      const c = m.content as { type?: string; text?: string }
      if (c.type === 'text' && c.text) parts.push(`[${role}] ${c.text}`)
      else parts.push(`[${role}] ${JSON.stringify(m.content)}`)
    } else {
      parts.push(`[${role}] ${String(m.content ?? '')}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * 将 readResource 返回的 contents 格式化为文本。
 * @param contents resource contents。
 * @returns 合并文本。
 */
export function formatMcpResourceContents(contents: unknown): string {
  if (!Array.isArray(contents)) return JSON.stringify(contents, null, 2)
  const parts: string[] = []
  for (const item of contents) {
    if (!item || typeof item !== 'object') continue
    const c = item as { uri?: string; text?: string; blob?: string; mimeType?: string }
    if (c.text) parts.push(c.text)
    else if (c.blob) parts.push(`[binary ${c.mimeType ?? 'data'} base64 omitted]`)
    else parts.push(JSON.stringify(item, null, 2))
  }
  return parts.join('\n\n') || '(空 resource)'
}
