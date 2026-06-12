// MCP 模块对外入口。
// 导出 initMcp / shutdownMcp / getMcpManager 供 CLI 与斜杠命令使用。
// 制作人：Moriarty_Dox

export { MCPManager, getMcpManager, initMcp, shutdownMcp } from './client.js'
export { loadMcpConfig, getGlobalMcpConfigPath, getProjectMcpConfigPath } from './config.js'
export type {
  McpConfigFile,
  McpServerConfig,
  McpServerStatus,
  McpResourceEntry,
  McpPromptEntry,
} from './types.js'
