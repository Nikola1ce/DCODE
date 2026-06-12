import { describe, expect, it } from 'vitest'
import { shouldRetryStreamError } from './client.js'

describe('shouldRetryStreamError', () => {
  it('在尚未输出可见增量时允许可重试错误重试', () => {
    expect(shouldRetryStreamError({ status: 429 }, 0, false)).toBe(true)
    expect(shouldRetryStreamError({ status: 500 }, 1, false)).toBe(true)
  })

  it('一旦已经输出可见增量就不再自动重试，避免 UI 重复落盘', () => {
    expect(shouldRetryStreamError({ status: 429 }, 0, true)).toBe(false)
    expect(shouldRetryStreamError({ code: 'ECONNRESET' }, 0, true)).toBe(false)
  })

  it('达到重试上限或不可重试错误时不重试', () => {
    expect(shouldRetryStreamError({ status: 429 }, 3, false)).toBe(false)
    expect(shouldRetryStreamError({ status: 400 }, 0, false)).toBe(false)
  })
})
