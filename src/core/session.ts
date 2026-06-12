// 会话持久化模块。
// 将每个会话以 JSONL（每行一个 JSON）形式保存到 ~/.dcode/sessions/<id>.jsonl，
// 支持：新建会话、追加消息、加载历史、列出最近会话、定位“最新会话”。
// 用于实现 dcode -c（继续上次会话）与 dcode -r（恢复指定会话）。
// 制作人：Moriarty_Dox

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfigDir } from '../config.js'
import type { DeepMessage } from './types.js'

// 会话文件头部的元信息（写入 JSONL 第一行）。
export interface SessionMeta {
  // 标记该行为元信息。
  type: 'meta'
  // 会话 id。
  id: string
  // 创建时间（ISO 字符串）。
  createdAt: string
  // 创建会话时的工作目录（用于 -c 时校验是否同一项目）。
  cwd: string
  // 创建时使用的模型。
  model: string
}

// 会话文件中的消息行。
interface MessageLine {
  // 标记该行为消息。
  type: 'message'
  // 消息内容。
  message: DeepMessage
}

/**
 * 计算会话目录路径（~/.dcode/sessions），不存在则创建。
 * @returns 会话目录绝对路径。
 */
function getSessionsDir(): string {
  const dir = join(getConfigDir(), 'sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 计算指定会话的文件路径。
 * @param id 会话 id。
 * @returns 会话 JSONL 文件绝对路径。
 */
function getSessionPath(id: string): string {
  return join(getSessionsDir(), `${id}.jsonl`)
}

/**
 * 会话记录器：封装单个会话文件的写入操作。
 * 通过实例方法追加消息，避免上层关心文件细节。
 */
export class SessionRecorder {
  // 当前会话 id。
  readonly id: string
  // 当前会话文件路径。
  private path: string
  // 是否禁用持久化（无头一次性任务可关闭）。
  private disabled: boolean

  /**
   * 构造函数。
   * @param id 会话 id。
   * @param disabled 是否禁用写盘。
   */
  constructor(id: string, disabled = false) {
    this.id = id
    this.path = getSessionPath(id)
    this.disabled = disabled
  }

  /**
   * 创建新会话并写入元信息头。
   * @param cwd 工作目录。
   * @param model 模型名。
   * @param disabled 是否禁用持久化。
   * @returns 新建的记录器实例。
   */
  static create(cwd: string, model: string, disabled = false): SessionRecorder {
    const id = randomUUID()
    const rec = new SessionRecorder(id, disabled)
    if (!disabled) {
      const meta: SessionMeta = {
        type: 'meta',
        id,
        createdAt: new Date().toISOString(),
        cwd,
        model,
      }
      writeFileSync(rec.path, JSON.stringify(meta) + '\n', 'utf8')
    }
    return rec
  }

  /**
   * 向会话文件追加一条消息。
   * @param message 要追加的消息。
   */
  append(message: DeepMessage): void {
    if (this.disabled) return
    const line: MessageLine = { type: 'message', message }
    try {
      appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8')
    } catch {
      // 写盘失败不应影响主流程。
    }
  }
}

/**
 * 加载指定会话的全部消息。
 * @param id 会话 id。
 * @returns 消息数组；文件不存在或损坏时返回空数组。
 */
export function loadSessionMessages(id: string): DeepMessage[] {
  const path = getSessionPath(id)
  if (!existsSync(path)) return []
  const messages: DeepMessage[] = []
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      const obj = JSON.parse(line)
      if (obj.type === 'message') messages.push(obj.message)
    }
  } catch {
    // 解析失败返回已成功解析的部分。
  }
  return messages
}

// 会话摘要信息（用于 /resume 列表展示）。
export interface SessionSummary {
  // 会话 id。
  id: string
  // 创建时间。
  createdAt: string
  // 工作目录。
  cwd: string
  // 文件最后修改时间（ms），用于排序。
  mtime: number
  // 首条用户消息（作为标题预览）。
  firstUserText: string
  // 消息条数。
  messageCount: number
}

/**
 * 列出所有会话的摘要，按最近修改时间倒序。
 * @param limit 最多返回条数，默认 20。
 * @returns 会话摘要数组。
 */
export function listSessions(limit = 20): SessionSummary[] {
  const dir = getSessionsDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  const summaries: SessionSummary[] = []

  for (const file of files) {
    const path = join(dir, file)
    try {
      const mtime = statSync(path).mtimeMs
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
      if (lines.length === 0) continue

      const meta = JSON.parse(lines[0]) as SessionMeta
      if (meta.type !== 'meta') continue

      // 找首条用户消息作为标题预览。
      let firstUserText = '(无内容)'
      let messageCount = 0
      for (let i = 1; i < lines.length; i++) {
        const obj = JSON.parse(lines[i])
        if (obj.type === 'message') {
          messageCount++
          if (
            obj.message.role === 'user' &&
            firstUserText === '(无内容)' &&
            obj.message.content
          ) {
            firstUserText = String(obj.message.content).slice(0, 60)
          }
        }
      }

      summaries.push({
        id: meta.id,
        createdAt: meta.createdAt,
        cwd: meta.cwd,
        mtime,
        firstUserText,
        messageCount,
      })
    } catch {
      // 跳过损坏的会话文件。
    }
  }

  summaries.sort((a, b) => b.mtime - a.mtime)
  return summaries.slice(0, limit)
}

/**
 * 获取在指定工作目录下“最近”的一个会话 id（供 dcode -c 使用）。
 * @param cwd 工作目录。
 * @returns 会话 id；没有则返回 null。
 */
export function getLatestSessionId(cwd: string): string | null {
  const sessions = listSessions(100)
  const normalizedCwd = normalize(cwd)
  // 仅匹配同一工作目录的会话；无匹配时不应回退到其他项目的会话。
  const sameCwd = sessions.find((s) => normalize(s.cwd) === normalizedCwd)
  return sameCwd?.id ?? null
}
