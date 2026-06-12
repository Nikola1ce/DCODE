// MCP 客户端管理器。
// 连接 mcp.json 中配置的各 MCP Server，拉取 tools/resources/prompts 并注册到 ToolRegistry。
// 制作人：Moriarty_Dox

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ToolDefinition, ToolResult } from '../core/types.js'
import { registerMcpTools } from '../tools/registry.js'
import { isValidMcpServerConfig, loadMcpConfig } from './config.js'
import {
  formatMcpPromptMessages,
  formatMcpResourceContents,
  formatMcpToolContent,
  mcpToolToDefinition,
} from './toolAdapter.js'
import { createMcpClient, createMcpTransport } from './transport.js'
import type {
  McpPromptEntry,
  McpResourceEntry,
  McpServerConfig,
  McpServerStatus,
  McpToolMeta,
} from './types.js'

/** 单个已连接 Server 的运行时句柄。 */
interface ConnectedServer {
  client: Client
  config: McpServerConfig
  transportKind: string
  tools: Tool[]
  resources: McpResourceEntry[]
  prompts: McpPromptEntry[]
  error?: string
}

/**
 * MCP 连接与会话管理：启动/停止/重载、工具调用与资源/Prompt 代理。
 */
export class MCPManager {
  private cwd = process.cwd()
  private servers = new Map<string, ConnectedServer>()
  private toolMeta = new Map<string, McpToolMeta>()
  private connectErrors = new Map<string, string>()

  /**
   * 读取配置并连接所有 MCP Server；失败 server 不阻塞其它 server。
   * @param cwd 工作目录（用于合并 .dcode/mcp.json）。
   */
  async start(cwd: string): Promise<void> {
    this.cwd = cwd
    await this.stop()
    const { mcpServers } = loadMcpConfig(cwd)

    for (const [id, cfg] of Object.entries(mcpServers)) {
      if (!isValidMcpServerConfig(id, cfg)) continue
      try {
        await this.connectServer(id, cfg)
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        this.connectErrors.set(id, msg)
        process.stderr.write(`[MCP] 连接失败 ${id}: ${msg}\n`)
      }
    }

    this.syncToolRegistry()
  }

  /**
   * 断开所有 MCP 连接并清空注册表。
   */
  async stop(): Promise<void> {
    for (const [id, conn] of this.servers.entries()) {
      try {
        await conn.client.close()
      } catch {
        // 忽略关闭错误
      }
      this.servers.delete(id)
    }
    this.toolMeta.clear()
    this.connectErrors.clear()
    registerMcpTools([])
  }

  /**
   * 重新加载配置并重连。
   * @param cwd 工作目录。
   */
  async reload(cwd?: string): Promise<void> {
    await this.start(cwd ?? this.cwd)
  }

  /**
   * 返回各 server 状态摘要。
   * @returns 状态列表。
   */
  getStatus(): McpServerStatus[] {
    const { mcpServers } = loadMcpConfig(this.cwd)
    const ids = new Set([
      ...Object.keys(mcpServers),
      ...this.servers.keys(),
      ...this.connectErrors.keys(),
    ])
    const result: McpServerStatus[] = []
    for (const id of ids) {
      const conn = this.servers.get(id)
      const err = this.connectErrors.get(id)
      if (conn) {
        result.push({
          id,
          connected: !conn.error,
          transport: conn.transportKind,
          error: conn.error,
          toolCount: conn.tools.length,
          resourceCount: conn.resources.length,
          promptCount: conn.prompts.length,
        })
      } else {
        result.push({
          id,
          connected: false,
          error: err ?? '未连接',
          toolCount: 0,
          resourceCount: 0,
          promptCount: 0,
        })
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * 已成功连接的 server id 列表。
   * @returns server id 数组。
   */
  getConnectedServerIds(): string[] {
    return [...this.servers.keys()].filter((id) => !this.servers.get(id)?.error)
  }

  /**
   * 列出所有 server 的工具摘要。
   * @returns 按 server 分组的工具信息。
   */
  listToolsSummary(): { serverId: string; tools: { name: string; description?: string }[] }[] {
    return [...this.servers.entries()].map(([serverId, conn]) => ({
      serverId,
      tools: conn.tools.map((t) => ({
        name: t.name,
        description: t.description ?? t.title,
      })),
    }))
  }

  /**
   * 聚合所有 server 的 resources。
   * @returns resource 条目列表。
   */
  listAllResources(): McpResourceEntry[] {
    const all: McpResourceEntry[] = []
    for (const [serverId, conn] of this.servers) {
      all.push(...conn.resources.map((r) => ({ ...r, serverId })))
    }
    return all
  }

  /**
   * 聚合所有 server 的 prompts。
   * @returns prompt 条目列表。
   */
  listAllPrompts(): McpPromptEntry[] {
    const all: McpPromptEntry[] = []
    for (const [serverId, conn] of this.servers) {
      all.push(...conn.prompts.map((p) => ({ ...p, serverId })))
    }
    return all
  }

  /**
   * 调用指定 server 的 MCP 工具。
   * @param serverId server id。
   * @param toolName 原始工具名。
   * @param input 入参对象。
   * @returns 工具结果。
   */
  async callToolDirect(
    serverId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const conn = this.servers.get(serverId)
    if (!conn || conn.error) {
      return {
        llmContent: `错误：MCP Server "${serverId}" 未连接。`,
        isError: true,
      }
    }
    try {
      const result = await conn.client.callTool({ name: toolName, arguments: input })
      const text = formatMcpToolContent(result.content)
      const isError = result.isError === true
      return {
        llmContent: text || (isError ? 'MCP 工具返回错误（无文本）' : '(完成)'),
        uiSummary: `MCP ${serverId}/${toolName}`,
        isError,
      }
    } catch (e: any) {
      return {
        llmContent: `MCP 工具执行失败：${e?.message ?? String(e)}`,
        isError: true,
      }
    }
  }

  /**
   * 读取指定 server 的 resource。
   * @param serverId server id。
   * @param uri resource URI。
   * @returns 工具结果格式文本。
   */
  async readResourceDirect(serverId: string, uri: string): Promise<ToolResult> {
    const conn = this.servers.get(serverId)
    if (!conn || conn.error) {
      return {
        llmContent: `错误：MCP Server "${serverId}" 未连接。`,
        isError: true,
      }
    }
    try {
      const result = await conn.client.readResource({ uri })
      return {
        llmContent: formatMcpResourceContents(result.contents),
        uiSummary: `读取 resource ${uri}`,
      }
    } catch (e: any) {
      return {
        llmContent: `读取 MCP resource 失败：${e?.message ?? String(e)}`,
        isError: true,
      }
    }
  }

  /**
   * 获取指定 server 的 prompt 内容。
   * @param serverId server id。
   * @param name prompt 名。
   * @param args prompt 参数。
   * @returns 工具结果格式文本。
   */
  async getPromptDirect(
    serverId: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<ToolResult> {
    const conn = this.servers.get(serverId)
    if (!conn || conn.error) {
      return {
        llmContent: `错误：MCP Server "${serverId}" 未连接。`,
        isError: true,
      }
    }
    try {
      const result = await conn.client.getPrompt({ name, arguments: args })
      const text = formatMcpPromptMessages(result.messages)
      const header = result.description ? `${result.description}\n\n` : ''
      return {
        llmContent: header + text,
        uiSummary: `MCP prompt ${serverId}/${name}`,
      }
    } catch (e: any) {
      return {
        llmContent: `获取 MCP prompt 失败：${e?.message ?? String(e)}`,
        isError: true,
      }
    }
  }

  /**
   * 判断某 server 是否配置为 trust（代理 read/get 可跳过授权）。
   * @param serverId server id。
   * @returns trust 为 true 时返回 true。
   */
  isServerTrusted(serverId: string): boolean {
    return this.servers.get(serverId)?.config.trust === true
  }

  /**
   * 连接单个 MCP Server 并缓存 tools/resources/prompts。
   * @param id server id。
   * @param cfg 配置。
   */
  private async connectServer(id: string, cfg: McpServerConfig): Promise<void> {
    const { transport, kind } = createMcpTransport(cfg)
    const client = createMcpClient()
    await client.connect(transport)

    const toolsResult = await client.listTools()
    const tools = toolsResult.tools ?? []

    let resources: McpResourceEntry[] = []
    try {
      const res = await client.listResources()
      resources = (res.resources ?? []).map((r) => ({
        serverId: id,
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }))
    } catch {
      // 部分 server 不支持 resources
    }

    let prompts: McpPromptEntry[] = []
    try {
      const pr = await client.listPrompts()
      prompts = (pr.prompts ?? []).map((p) => ({
        serverId: id,
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      }))
    } catch {
      // 部分 server 不支持 prompts
    }

    this.servers.set(id, {
      client,
      config: cfg,
      transportKind: kind,
      tools,
      resources,
      prompts,
    })
    this.connectErrors.delete(id)
  }

  /**
   * 将当前连接上的 MCP 工具注册到全局 ToolRegistry。
   */
  private syncToolRegistry(): void {
    const definitions: ToolDefinition[] = []
    this.toolMeta.clear()
    const callTool = this.callToolDirect.bind(this)

    for (const [serverId, conn] of this.servers) {
      if (conn.error) continue
      for (const tool of conn.tools) {
        const { definition, meta } = mcpToolToDefinition(
          serverId,
          tool,
          conn.config.trust === true,
          callTool,
        )
        definitions.push(definition)
        this.toolMeta.set(definition.name, meta)
      }
    }

    registerMcpTools(definitions)
  }
}

/** 全局 MCPManager 单例。 */
let manager: MCPManager | null = null

/**
 * 获取全局 MCPManager（未 init 时返回 null）。
 * @returns MCPManager 或 null。
 */
export function getMcpManager(): MCPManager | null {
  return manager
}

/**
 * 启动 MCP：加载配置、连接 server、注册工具。
 * @param cwd 工作目录。
 * @returns MCPManager 实例。
 */
export async function initMcp(cwd: string): Promise<MCPManager> {
  manager = new MCPManager()
  await manager.start(cwd)
  return manager
}

/**
 * 关闭 MCP 连接并释放资源。
 */
export async function shutdownMcp(): Promise<void> {
  await manager?.stop()
  manager = null
}
