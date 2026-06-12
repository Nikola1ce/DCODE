// 文件类工具的并发锁。
// Agent / 子代理并行执行 tool_calls 时，对同一路径的 read/write/edit 串行化，避免交错写入。
// 制作人：Moriarty_Dox

import type { ToolCall } from './types.js'

/** 需按文件路径串行化的工具名。 */
const FILE_LOCK_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])

/**
 * 从工具调用中提取用于文件锁的路径键。
 * @param call 工具调用。
 * @returns 路径字符串；非文件类工具返回 null。
 */
export function extractFileLockKey(call: ToolCall): string | null {
  if (!FILE_LOCK_TOOLS.has(call.name)) return null
  try {
    const input = call.argsJson ? JSON.parse(call.argsJson) : {}
    if (typeof input.path === 'string' && input.path.trim()) {
      return input.path.trim()
    }
  } catch {
    // 入参非法时不在此层加锁，executeToolCall 会返回 JSON 错误。
  }
  return null
}

/**
 * 对同一文件路径的工具调用串行执行，避免并行 write/edit 交错。
 * @param locks 本轮工具调用的路径锁表。
 * @param key 文件路径键；null 表示无需加锁。
 * @param fn 实际执行函数。
 * @returns fn 的返回值。
 */
export async function withFilePathLock<T>(
  locks: Map<string, Promise<void>>,
  key: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn()
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(key, prev.then(() => gate))
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}
