// MCP 协议相关类型定义。
// 描述 mcp.json 配置结构、Server 连接状态及工具元信息，供 client/config/toolAdapter 共享。
// 制作人：Moriarty_Dox

/** 单个 MCP Server 的配置（stdio 或 HTTP/SSE）。 */
export interface McpServerConfig {
  /** stdio：启动 Server 的可执行文件路径。 */
  command?: string
  /** stdio：命令行参数。 */
  args?: string[]
  /** stdio：子进程环境变量（与父进程合并）。 */
  env?: Record<string, string>
  /** stdio：子进程工作目录。 */
  cwd?: string
  /** 远程：Server URL（Streamable HTTP 或 SSE）。 */
  url?: string
  /** 远程传输类型：http（默认）| sse。 */
  type?: 'http' | 'sse'
  /** 远程请求附加头（如 Authorization）。 */
  headers?: Record<string, string>
  /** 为 true 时 MCP 写操作工具跳过权限弹窗（仍受 plan 模式约束）。 */
  trust?: boolean
  /** 为 false 时跳过连接（便于临时禁用）。 */
  enabled?: boolean
}

/** mcp.json 根结构。 */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>
}

/** 单个 Server 的运行时状态（供 /mcp 展示）。 */
export interface McpServerStatus {
  /** 配置中的 server id。 */
  id: string
  /** 是否已成功连接并完成 initialize。 */
  connected: boolean
  /** 传输类型：stdio | http | sse。 */
  transport?: string
  /** 连接失败时的错误信息。 */
  error?: string
  /** 已注册工具数量。 */
  toolCount: number
  /** 已知 resource 数量。 */
  resourceCount: number
  /** 已知 prompt 数量。 */
  promptCount: number
}

/** MCP 动态工具元信息（用于 callTool 反查 server 与原工具名）。 */
export interface McpToolMeta {
  serverId: string
  originalName: string
  readOnly: boolean
  trust: boolean
}

/** 聚合后的 MCP Resource 条目。 */
export interface McpResourceEntry {
  serverId: string
  uri: string
  name: string
  description?: string
  mimeType?: string
}

/** 聚合后的 MCP Prompt 条目。 */
export interface McpPromptEntry {
  serverId: string
  name: string
  description?: string
  arguments?: { name: string; description?: string; required?: boolean }[]
}
