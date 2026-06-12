// session 单元测试。
// 验证恢复历史时可修复缺失的 tool 结果，避免继续会话时消息协议不完整。

import { describe, expect, it } from 'vitest'
import { repairInterruptedToolResults } from './session.js'
import type { DeepMessage } from './types.js'

describe('repairInterruptedToolResults', () => {
  it('为缺失 tool 结果的 assistant tool_call 原位补合成错误', () => {
    const messages: DeepMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'write_file', argsJson: '{}' }],
      },
      { role: 'user', content: 'continue' },
    ]

    const repaired = repairInterruptedToolResults(messages)

    expect(repaired[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_1',
      toolName: 'write_file',
      isError: true,
      metadata: { kind: 'synthetic_error', source: 'system' },
    })
    expect(repaired[3]).toMatchObject({ role: 'user', content: 'continue' })
  })

  it('已有 tool 结果时不重复补齐', () => {
    const messages: DeepMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read_file', argsJson: '{}' }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call_1', toolName: 'read_file' },
    ]

    expect(repairInterruptedToolResults(messages)).toBe(messages)
  })
})
