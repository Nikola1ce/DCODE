// 有界服务请求与过期响应隔离，切换项目后丢弃旧页面的请求结果。
// 制作人：Moriarty_Dox
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result } from '../shared/api.js'

export async function unwrap<T>(request: Promise<Result<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  return result.value
}

export function useResource<T>(key: string, load: () => Promise<T>) {
  const loader = useRef(load)
  loader.current = load
  const [value, setValue] = useState<T>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((previous) => previous + 1), [])
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const request = loader.current
    const load = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try { return await request() }
        catch (reason) {
          if (!active || attempt >= 5 || (reason as { code?: string } | null)?.code !== 'BUSY') throw reason
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
    }
    void load().then((next) => {
      if (active) setValue(next)
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '无法读取数据，请重试。')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [key, revision])
  return { value, error, loading, refresh }
}

export function useAction(refresh?: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  async function run(operation: () => Promise<unknown>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try { await operation() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败，请重试。') }
    finally { lock.current = false; setBusy(false); refresh?.() }
  }
  return { busy, error, run }
}

export function useDraft(key: string) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('dcode.drafts') ?? '{}')
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      return Object.fromEntries(Object.entries(raw).filter(([name, value]) => name.length < 2048 && typeof value === 'string' && value.length <= 32_000).slice(-40))
    } catch { return {} }
  })
  function update(value: string) {
    setDrafts((previous) => {
      let saved = previous
      try { saved = JSON.parse(localStorage.getItem('dcode.drafts') ?? '{}') as Record<string, string> } catch { /* 使用内存草稿。 */ }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = previous
      const next = Object.fromEntries([...Object.entries(saved).filter(([name, text]) => name !== key && typeof text === 'string' && text.length <= 32_000), [key, value]].slice(-40))
      try { localStorage.setItem('dcode.drafts', JSON.stringify(next)) } catch { /* 空间不足时仍保留窗口内草稿。 */ }
      return next
    })
  }
  return [drafts[key] ?? '', update] as const
}
