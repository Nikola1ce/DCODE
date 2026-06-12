// fileToolLock 单元测试。
// 验证同一路径的工具调用会串行执行。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import { extractFileLockKey, withFilePathLock } from './fileToolLock.js'
import type { ToolCall } from './types.js'

describe('extractFileLockKey', () => {
  it('read_file 返回 path', () => {
    const call: ToolCall = {
      id: '1',
      name: 'read_file',
      argsJson: JSON.stringify({ path: 'src/a.ts' }),
    }
    expect(extractFileLockKey(call)).toBe('src/a.ts')
  })

  it('非文件工具返回 null', () => {
    const call: ToolCall = { id: '1', name: 'grep', argsJson: '{}' }
    expect(extractFileLockKey(call)).toBeNull()
  })
})

describe('withFilePathLock', () => {
  it('同一路径串行执行', async () => {
    const locks = new Map<string, Promise<void>>()
    const order: number[] = []

    await Promise.all([
      withFilePathLock(locks, 'same.txt', async () => {
        order.push(1)
        await new Promise((r) => setTimeout(r, 30))
        order.push(2)
      }),
      withFilePathLock(locks, 'same.txt', async () => {
        order.push(3)
      }),
    ])

    expect(order).toEqual([1, 2, 3])
  })

  it('不同路径可并行', async () => {
    const locks = new Map<string, Promise<void>>()
    let parallel = 0
    let maxParallel = 0

    await Promise.all([
      withFilePathLock(locks, 'a.txt', async () => {
        parallel++
        maxParallel = Math.max(maxParallel, parallel)
        await new Promise((r) => setTimeout(r, 20))
        parallel--
      }),
      withFilePathLock(locks, 'b.txt', async () => {
        parallel++
        maxParallel = Math.max(maxParallel, parallel)
        await new Promise((r) => setTimeout(r, 20))
        parallel--
      }),
    ])

    expect(maxParallel).toBe(2)
  })
})
