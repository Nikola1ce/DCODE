// MCP 代理工具。
// 提供 list/read resources 与 list/get prompts 四个内置工具，统一代理到 MCPManager。
// 制作人：Moriarty_Dox

import type { ToolDefinition, ToolContext, ToolResult } from '../core/types.js'
import { getMcpManager } from '../mcp/client.js'

/**
 * 获取 MCPManager；未初始化时返回友好错误结果。
 * @returns manager 或 null。
 */
function requireManager(): ReturnType<typeof getMcpManager> {
  return getMcpManager()
}

/**
 * 无 MCP 连接时的统一错误结果。
 * @returns ToolResult。
 */
function noMcpResult(): ToolResult {
  return {
    llmContent:
      '当前未连接任何 MCP Server。请在 ~/.dcode/mcp.json 配置 mcpServers 后重启，或执行 /mcp reload。',
    isError: true,
  }
}

/** 列出所有已连接 MCP Server 的 resources。 */
export const listMcpResourcesTool: ToolDefinition = {
  name: 'list_mcp_resources',
  description:
    '列出所有已连接 MCP Server 提供的 resources（URI、名称、所属 server）。' +
    '在 read_mcp_resource 之前先用本工具发现可用 URI。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      server_id: {
        type: 'string',
        description: '可选：仅列出指定 server id 的 resources',
      },
    },
  },
  renderCall: (input: { server_id?: string }) =>
    input.server_id
      ? `列出 MCP resources（${input.server_id}）`
      : '列出全部 MCP resources',
  run: async (input: { server_id?: string }): Promise<ToolResult> => {
    const mgr = requireManager()
    if (!mgr) return noMcpResult()
    let items = mgr.listAllResources()
    if (input.server_id) {
      items = items.filter((r) => r.serverId === input.server_id)
    }
    if (items.length === 0) {
      return { llmContent: '（无 MCP resources 或未连接 server）' }
    }
    const lines = items.map(
      (r) =>
        `- [${r.serverId}] ${r.uri} (${r.name})${r.description ? ': ' + r.description : ''}`,
    )
    return {
      llmContent: lines.join('\n'),
      uiSummary: `共 ${items.length} 个 resource`,
    }
  },
}

/** 读取指定 MCP resource 内容。 */
export const readMcpResourceTool: ToolDefinition = {
  name: 'read_mcp_resource',
  description: '通过 MCP 读取指定 server 上某个 resource URI 的内容。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      server_id: { type: 'string', description: 'MCP server id（mcp.json 中的键名）' },
      uri: { type: 'string', description: 'resource URI' },
    },
    required: ['server_id', 'uri'],
  },
  renderCall: (input: { server_id: string; uri: string }) =>
    `读取 MCP resource ${input.server_id}:${input.uri}`,
  checkPermission: (input: { server_id: string; uri: string }, _ctx) => {
    const mgr = requireManager()
    if (mgr?.isServerTrusted(input.server_id)) return null
    return {
      toolName: 'read_mcp_resource',
      title: `读取 MCP resource ${input.server_id} → ${input.uri}`,
      ruleKey: `MCPResource(${input.server_id})`,
    }
  },
  run: async (
    input: { server_id: string; uri: string },
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    if (ctx.abortSignal.aborted) {
      return { llmContent: '已取消', isError: true }
    }
    const mgr = requireManager()
    if (!mgr) return noMcpResult()
    return mgr.readResourceDirect(input.server_id, input.uri)
  },
}

/** 列出所有 MCP prompts。 */
export const listMcpPromptsTool: ToolDefinition = {
  name: 'list_mcp_prompts',
  description:
    '列出所有已连接 MCP Server 提供的 prompts（名称、参数、所属 server）。' +
    '在 get_mcp_prompt 之前先用本工具发现可用 prompt。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      server_id: { type: 'string', description: '可选：仅列出指定 server 的 prompts' },
    },
  },
  renderCall: (input: { server_id?: string }) =>
    input.server_id ? `列出 MCP prompts（${input.server_id}）` : '列出全部 MCP prompts',
  run: async (input: { server_id?: string }): Promise<ToolResult> => {
    const mgr = requireManager()
    if (!mgr) return noMcpResult()
    let items = mgr.listAllPrompts()
    if (input.server_id) {
      items = items.filter((p) => p.serverId === input.server_id)
    }
    if (items.length === 0) {
      return { llmContent: '（无 MCP prompts 或未连接 server）' }
    }
    const lines = items.map((p) => {
      const args =
        p.arguments?.map((a) => a.name + (a.required ? '*' : '')).join(', ') ?? ''
      return `- [${p.serverId}] ${p.name}${args ? ` (${args})` : ''}${p.description ? ': ' + p.description : ''}`
    })
    return {
      llmContent: lines.join('\n'),
      uiSummary: `共 ${items.length} 个 prompt`,
    }
  },
}

/** 获取并展开 MCP prompt 内容。 */
export const getMcpPromptTool: ToolDefinition = {
  name: 'get_mcp_prompt',
  description:
    '从指定 MCP Server 获取 prompt 模板内容（可传入 prompt 所需参数 arguments）。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      server_id: { type: 'string', description: 'MCP server id' },
      name: { type: 'string', description: 'prompt 名称' },
      arguments: {
        type: 'object',
        description: 'prompt 参数键值对（可选）',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['server_id', 'name'],
  },
  renderCall: (input: { server_id: string; name: string }) =>
    `获取 MCP prompt ${input.server_id}/${input.name}`,
  checkPermission: (input: { server_id: string; name: string }, _ctx) => {
    const mgr = requireManager()
    if (mgr?.isServerTrusted(input.server_id)) return null
    return {
      toolName: 'get_mcp_prompt',
      title: `获取 MCP prompt ${input.server_id}/${input.name}`,
      ruleKey: `MCPPrompt(${input.server_id})`,
    }
  },
  run: async (
    input: { server_id: string; name: string; arguments?: Record<string, string> },
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    if (ctx.abortSignal.aborted) {
      return { llmContent: '已取消', isError: true }
    }
    const mgr = requireManager()
    if (!mgr) return noMcpResult()
    return mgr.getPromptDirect(input.server_id, input.name, input.arguments)
  },
}

/** 四个 MCP 代理工具集合。 */
export const MCP_PROXY_TOOLS: ToolDefinition[] = [
  listMcpResourcesTool,
  readMcpResourceTool,
  listMcpPromptsTool,
  getMcpPromptTool,
]
