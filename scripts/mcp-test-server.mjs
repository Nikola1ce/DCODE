#!/usr/bin/env node
/**
 * 最小 MCP 测试 Server（stdio）。
 * 供 DCODE MCP E2E 验证：提供 echo 工具、demo resource 与 demo prompt。
 * 用法：node scripts/mcp-test-server.mjs
 * 制作人：Moriarty_Dox
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'dcode-test', version: '1.0.0' })

server.registerTool(
  'echo',
  {
    description: '回显输入文本（测试用）',
    inputSchema: { text: z.string().describe('要回显的文本') },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `echo: ${text}` }],
  }),
)

server.registerTool(
  'write_demo',
  {
    description: '模拟写操作（测试 plan 模式拦截）',
    inputSchema: { value: z.string() },
    annotations: { readOnlyHint: false },
  },
  async ({ value }) => ({
    content: [{ type: 'text', text: `would write: ${value}` }],
  }),
)

server.registerResource(
  'demo',
  'test://demo/info',
  {
    description: '演示 resource',
    mimeType: 'text/plain',
  },
  async () => ({
    contents: [
      {
        uri: 'test://demo/info',
        mimeType: 'text/plain',
        text: 'Hello from MCP demo resource',
      },
    ],
  }),
)

server.registerPrompt(
  'greet',
  {
    description: '问候 prompt',
    argsSchema: { name: z.string().describe('姓名') },
  },
  async ({ name }) => ({
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: `你好，${name}！这是 MCP demo prompt。` },
      },
    ],
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
