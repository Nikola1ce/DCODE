// download 单元测试。
// 重点验证「停顿（stall）超时」：当响应体在中途永久挂起（服务器接受连接却不再发数据）时，
// readResponseWithProgress 不会无限等待，而是按 stallTimeoutMs 主动中断并抛 AbortError。
// 这是修复「web_fetch 一直转圈」卡死问题的核心保障。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import { readResponseWithProgress, formatBytes, formatDuration } from './download.js'

/**
 * 用「完全可控的假 reader」构造一个最小 Response 替身（避免依赖 undici 内部缓冲行为的不确定性）。
 * 假 reader 依次产出给定结果；越界后默认返回永不 resolve 的 read()（模拟挂起）。
 * @param steps 每次 read() 的产出序列；done 表示流结束。
 * @param hangAfter 序列耗尽后是否挂起（true=永不 resolve，模拟僵死；false=返回 done）。
 * @returns Response 替身（仅实现 readResponseWithProgress 需要的 body.getReader）。
 */
function makeFakeResponse(
  steps: Array<{ value?: Uint8Array; done?: boolean }>,
  hangAfter: boolean,
): Response {
  let i = 0
  let cancelled = false
  type ReadResult = { done?: boolean; value?: Uint8Array }
  const reader = {
    read(): Promise<ReadResult> {
      if (cancelled) return Promise.resolve({ done: true, value: undefined })
      if (i < steps.length) {
        const s = steps[i++]
        return Promise.resolve(
          s.done
            ? { done: true, value: undefined }
            : { done: false, value: s.value as Uint8Array },
        )
      }
      if (hangAfter) return new Promise<never>(() => {}) // 永久挂起。
      return Promise.resolve({ done: true, value: undefined })
    },
    cancel(): Promise<void> {
      cancelled = true
      return Promise.resolve()
    },
  }
  // 仅需 body.getReader()；headers 用空 Headers（无 content-length）。
  return {
    headers: new Headers(),
    body: { getReader: () => reader },
  } as unknown as Response
}

/** 先发若干块、之后永久挂起的 Response 替身。 */
function makeHangingResponse(chunks: Uint8Array[]): Response {
  return makeFakeResponse(
    chunks.map((value) => ({ value })),
    true,
  )
}

/** 正常、可读完的 Response 替身。 */
function makeNormalResponse(chunks: Uint8Array[]): Response {
  return makeFakeResponse(
    [...chunks.map((value) => ({ value })), { done: true }],
    false,
  )
}

describe('readResponseWithProgress · stall 超时', () => {
  it('响应体中途挂起时，按 stallTimeoutMs 抛 AbortError 而非无限等待', async () => {
    const res = makeHangingResponse([new Uint8Array([1, 2, 3])])
    const start = Date.now()
    await expect(
      readResponseWithProgress(res, { stallTimeoutMs: 50 }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // 应在远小于「无限」的时间内返回（给足余量，避免 CI 抖动误判）。
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('正常响应可完整读取，不受 stall 超时影响', async () => {
    const res = makeNormalResponse([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
    ])
    const bytes = await readResponseWithProgress(res, { stallTimeoutMs: 1000 })
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5])
  })

  it('读取挂起时，abort 信号能立即（不等 stall 超时）跳出', async () => {
    const res = makeHangingResponse([new Uint8Array([1, 2, 3])])
    const controller = new AbortController()
    const start = Date.now()
    // stall 超时设很大（5s），但 50ms 后 abort：应在远小于 stall 的时间内因 abort 跳出。
    setTimeout(() => controller.abort(), 50)
    await expect(
      readResponseWithProgress(res, { stallTimeoutMs: 5000, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('会回调进度（至少首帧与末帧）', async () => {
    const res = makeNormalResponse([new Uint8Array([1, 2, 3, 4])])
    const frames: number[] = []
    await readResponseWithProgress(res, {
      stallTimeoutMs: 1000,
      throttleMs: 0,
      onProgress: (p) => frames.push(p.receivedBytes),
    })
    expect(frames.length).toBeGreaterThanOrEqual(2)
    // 末帧应为完整字节数。
    expect(frames[frames.length - 1]).toBe(4)
  })
})

describe('download 格式化辅助', () => {
  it('formatBytes 进位正确', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
  })

  it('formatDuration 处理 null 与分秒', () => {
    expect(formatDuration(null)).toBe('--')
    expect(formatDuration(5)).toBe('5s')
    expect(formatDuration(75)).toBe('1m 15s')
  })
})
