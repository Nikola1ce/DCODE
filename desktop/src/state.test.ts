// 渲染状态仅消费安全事件；确认流式合并、大小限制及中断后不伪装完成。
// 制作人：Moriarty_Dox
import { describe, expect, it } from 'vitest'
import { INITIAL_CHAT_STATE, reduceEvents } from './state.js'
import { EMPTY_SNAPSHOT } from '../shared/api.js'

describe('桌面对话状态', () => {
  it('新会话握手期间清空旧回合，保留同会话重连的消息', () => {
    const connected = { ...EMPTY_SNAPSHOT, cwd: '/project', sessionId: 'old' }
    const state = reduceEvents(INITIAL_CHAT_STATE, [{ type: 'connection', snapshot: connected }, { type: 'turn_started', requestId: 'r', text: 'old' }])
    expect(reduceEvents(state, [{ type: 'connection', snapshot: { ...connected, phase: 'starting' } }]).turns).toHaveLength(1)
    expect(reduceEvents(state, [{ type: 'connection', snapshot: { ...connected, sessionId: null, phase: 'starting' } }]).turns).toEqual([])
  })
  it('一批流式事件保持顺序，完成后显示真实终态', () => {
    const state = reduceEvents(INITIAL_CHAT_STATE, [
      { type: 'turn_started', requestId: 'r1', text: 'test' },
      { type: 'stream', message: { type: 'text', requestId: 'r1', delta: '你' } },
      { type: 'stream', message: { type: 'text', requestId: 'r1', delta: '好' } },
      { type: 'stream', message: { type: 'turn_done', requestId: 'r1', reason: 'aborted', costUsd: 0 } },
    ])
    expect(state.turns[0]).toMatchObject({ prompt: 'test', text: '你好', status: 'aborted', costUsd: 0 })
  })

  it('崩溃恢复只变更连接状态，不创建/重发用户消息', () => {
    const initial = reduceEvents(INITIAL_CHAT_STATE, [
      { type: 'connection', snapshot: { ...EMPTY_SNAPSHOT, cwd: '/project', sessionId: 's1', phase: 'ready' } },
      { type: 'turn_started', requestId: 'r1', text: 'test' },
    ])
    const result = reduceEvents(initial, [
      { type: 'turn_interrupted', requestId: 'r1', error: { code: 'CORE_EXITED', message: 'interrupted' } },
      { type: 'connection', snapshot: { ...initial.snapshot, phase: 'ready' } },
    ])
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]).toMatchObject({ status: 'error', error: 'interrupted' })
  })

  it('流式文本有界，切换授权工作区时清空旧窗口视图', () => {
    const state = reduceEvents(INITIAL_CHAT_STATE, [
      { type: 'turn_started', requestId: 'r1', text: 'test' },
      { type: 'stream', message: { type: 'text', requestId: 'r1', delta: 'x'.repeat(300 * 1024) } },
    ])
    expect(state.turns[0].text).toHaveLength(256 * 1024)
    expect(reduceEvents(state, [{ type: 'connection', snapshot: { ...EMPTY_SNAPSHOT, cwd: '/other' } }]).turns).toEqual([])
  })
})
