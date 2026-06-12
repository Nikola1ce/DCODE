// MCP 传输层工厂。
// 根据 mcp.json 中的 server 配置创建 stdio / Streamable HTTP / SSE 传输实例。
// 制作人：Moriarty_Dox

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig } from './types.js'

/** 创建传输实例的返回结构。 */
export interface CreatedTransport {
  transport: Transport
  kind: 'stdio' | 'http' | 'sse'
}

/**
 * 根据 server 配置创建 MCP 传输。
 * @param config 单 server 配置。
 * @throws 配置缺少 command 与 url 时抛出。
 * @returns 传输实例与类型标记。
 */
export function createMcpTransport(config: McpServerConfig): CreatedTransport {
  if (config.command?.trim()) {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env,
      cwd: config.cwd,
      stderr: 'pipe',
    })
    return { transport, kind: 'stdio' }
  }

  if (config.url?.trim()) {
    const url = new URL(config.url)
    const headers = config.headers ?? {}
    const requestInit: RequestInit = { headers }

    if (config.type === 'sse') {
      return {
        transport: new SSEClientTransport(url, { requestInit }),
        kind: 'sse',
      }
    }

    return {
      transport: new StreamableHTTPClientTransport(url, { requestInit }),
      kind: 'http',
    }
  }

  throw new Error('MCP 配置无效：需指定 command（stdio）或 url（HTTP/SSE）')
}

/**
 * 创建已配置能力的 MCP Client 实例。
 * @returns SDK Client。
 */
export function createMcpClient(): Client {
  return new Client(
    { name: 'dcode', version: '1.0.0' },
    {
      capabilities: {
        roots: { listChanged: false },
        sampling: {},
      },
    },
  )
}
