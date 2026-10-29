// session 单元测试。
// 验证恢复历史时可修复缺失的 tool 结果，避免继续会话时消息协议不完整。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
const disk = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', () => ({ getConfigDir: () => disk.dir }))
import { getLatestSessionId, listSessions, loadSessionMessages, repairInterruptedToolResults, SessionRecorder } from './session.js'
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

  it('前一轮同名 toolCallId 的结果不能充当本轮结果', () => {
    const assistant: DeepMessage = { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', argsJson: '{}' }] }
    const result = repairInterruptedToolResults([
      assistant, { role: 'tool', content: '第一轮结果', toolCallId: 'call_1' },
      { role: 'user', content: '再读一次' }, { ...assistant },
    ])
    expect(result).toHaveLength(5)
    expect(result[4]).toMatchObject({ role: 'tool', toolCallId: 'call_1', isError: true })
    expect(repairInterruptedToolResults(result)).toBe(result)
  })

  it('孤立及重复结果被移除，部分完成的工具批次仅补缺失项', () => {
    const assistant: DeepMessage = { role: 'assistant', content: '', toolCalls: [
      { id: 'one', name: 'read_file', argsJson: '{}' }, { id: 'two', name: 'read_file', argsJson: '{}' },
    ] }
    const valid: DeepMessage = { role: 'tool', content: '有效结果', toolCallId: 'two' }
    const result = repairInterruptedToolResults([
      { role: 'tool', content: '孤立结果', toolCallId: 'one' }, assistant,
      valid, { ...valid }, { role: 'user', content: '继续' },
      { role: 'tool', content: '迟到结果', toolCallId: 'one' },
    ])
    expect(result).toHaveLength(4)
    expect(result[0]).toBe(assistant)
    expect(result[1]).toBe(valid)
    expect(result[2]).toMatchObject({ toolCallId: 'one', isError: true })
    expect(result[3]).toMatchObject({ role: 'user', content: '继续' })
  })
})

describe('会话日志恢复', () => {
  beforeEach(() => { disk.dir = mkdtempSync(join(tmpdir(), 'dcode-session-test-')) })
  afterEach(() => {
    const target = resolve(disk.dir)
    if (dirname(target) !== resolve(tmpdir()) || !target.includes('dcode-session-test-')) {
      throw new Error('测试临时目录不在预期位置')
    }
    rmSync(target, { recursive: true, force: true })
  })

  it('最新快照替换旧消息，快照后的新增消息和摘要计数一致', () => {
    const rec = SessionRecorder.create(process.cwd(), 'test-model')
    rec.append({ role: 'user', content: '旧任务' })
    rec.append({ role: 'assistant', content: '旧回答' })
    rec.replaceMessages([{ role: 'system', content: '压缩摘要' }])
    rec.appendEvent({ type: 'run_start', runId: 'r', turnId: 't', timestamp: 1 })
    rec.append({ role: 'user', content: '新任务' })
    expect(loadSessionMessages(rec.id).map((m) => m.content)).toEqual(['压缩摘要', '新任务'])
    expect(listSessions()[0]).toMatchObject({ id: rec.id, firstUserText: '新任务', messageCount: 2 })
    const raw = readFileSync(join(disk.dir, 'sessions', `${rec.id}.jsonl`), 'utf8')
    expect(raw).toContain('旧任务')
    rec.replaceMessages([])
    expect(loadSessionMessages(rec.id)).toEqual([])
    expect(listSessions()[0].messageCount).toBe(0)
  })

  it('半行日志不隐藏会话，重新打开后新消息不被拼进坏行', () => {
    const rec = SessionRecorder.create(process.cwd(), 'test-model')
    rec.append({ role: 'user', content: '原始任务' })
    const file = join(disk.dir, 'sessions', `${rec.id}.jsonl`)
    appendFileSync(file, '{"type":"event","event":')
    expect(listSessions()[0].id).toBe(rec.id)
    const resumed = new SessionRecorder(rec.id)
    resumed.append({ role: 'user', content: '继续任务' })
    appendFileSync(file, '\n{"type":"message","message":null}\n')
    resumed.append({ role: 'assistant', content: '恢复后的回答' })
    expect(loadSessionMessages(rec.id).map((m) => m.content)).toEqual(['原始任务', '继续任务', '恢复后的回答'])
    expect(listSessions()[0].messageCount).toBe(3)
  })

  it('无尾换行的完整消息在恢复追加后也保留', () => {
    const rec = SessionRecorder.create(process.cwd(), 'test-model')
    appendFileSync(join(disk.dir, 'sessions', `${rec.id}.jsonl`), JSON.stringify({ type: 'message', message: { role: 'user', content: '完整末行' } }))
    new SessionRecorder(rec.id).append({ role: 'assistant', content: '新回答' })
    expect(loadSessionMessages(rec.id).map((m) => m.content)).toEqual(['完整末行', '新回答'])
  })

  it.each(['../outside', '..\\outside', 'C:\\outside', '/outside', 'bad/id', ''])('拒绝越界或非法会话 ID %s', (id) => {
    expect(() => new SessionRecorder(id)).toThrow('会话 ID')
    expect(() => loadSessionMessages(id)).toThrow('会话 ID')
  })

  it('其它项目超过 100 个新会话时仍可继续当前项目旧会话', () => {
    const cwd = join(disk.dir, 'project')
    const target = SessionRecorder.create(cwd, 'test-model')
    utimesSync(join(disk.dir, 'sessions', `${target.id}.jsonl`), 1, 1)
    for (let i = 0; i < 101; i++) SessionRecorder.create(join(disk.dir, `other-${i}`), 'test-model')
    expect(getLatestSessionId(cwd + '/')).toBe(target.id)
  })
})
