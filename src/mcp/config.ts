// MCP 配置文件加载。
// 读取 ~/.dcode/mcp.json 并与项目 .dcode/mcp.json 合并（项目同名 server 覆盖全局）。
// 制作人：Moriarty_Dox

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config.js'
import { isProjectConfigTrusted } from '../core/projectTrust.js'
import { MCP_CONFIG_FILE_NAME } from '../constants.js'
import type { McpConfigFile, McpServerConfig } from './types.js'

/**
 * 全局 MCP 配置文件绝对路径（~/.dcode/mcp.json）。
 * @returns 配置文件路径。
 */
export function getGlobalMcpConfigPath(): string {
  return join(getConfigDir(), MCP_CONFIG_FILE_NAME)
}

/**
 * 项目级 MCP 配置文件绝对路径（<cwd>/.dcode/mcp.json）。
 * @param cwd 工作目录。
 * @returns 配置文件路径。
 */
export function getProjectMcpConfigPath(cwd: string): string {
  return join(cwd, '.dcode', MCP_CONFIG_FILE_NAME)
}

/**
 * 从磁盘读取单个 mcp.json；不存在或损坏时返回空配置。
 * @param path 文件路径。
 * @returns 解析后的配置。
 */
function readMcpFile(path: string): McpConfigFile {
  if (!existsSync(path)) return { mcpServers: {} }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<McpConfigFile>
    const servers = raw.mcpServers
    if (!servers || typeof servers !== 'object') return { mcpServers: {} }
    return { mcpServers: servers as Record<string, McpServerConfig> }
  } catch {
    return { mcpServers: {} }
  }
}

/**
 * 校验单个 server 配置是否具备 stdio 或 url 之一。
 * @param id server id。
 * @param cfg 配置对象。
 * @returns 合法返回 true。
 */
export function isValidMcpServerConfig(id: string, cfg: McpServerConfig): boolean {
  if (cfg.enabled === false) return false
  const hasStdio = !!cfg.command?.trim()
  const hasUrl = !!cfg.url?.trim()
  return hasStdio || hasUrl
}

/**
 * 加载合并后的 MCP 配置（全局 + 项目）。
 * @param cwd 当前工作目录。
 * @returns 合并后的 mcpServers。
 */
export function loadMcpConfig(cwd: string): McpConfigFile {
  const globalCfg = readMcpFile(getGlobalMcpConfigPath())
  // 项目级 MCP 配置可能 spawn 任意命令，仅在用户显式信任该项目时合并。
  const projectCfg = isProjectConfigTrusted(cwd)
    ? readMcpFile(getProjectMcpConfigPath(cwd))
    : { mcpServers: {} }
  return {
    mcpServers: { ...globalCfg.mcpServers, ...projectCfg.mcpServers },
  }
}
