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
  const [resolvedKey, setResolvedKey] = useState<string | null>(null)
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
      if (active) { setValue(next); setResolvedKey(key) }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '无法读取数据，请重试。')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [key, revision])
  return { value, error, loading, refresh, resolvedKey }
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

const draftPrefix = 'dcode.draft.v2:'
const draftLimit = 40

function loadDraft(key: string): string {
  let fallback = ''
  try {
    const current = localStorage.getItem(draftPrefix + key)
    if (current !== null) {
      const saved = JSON.parse(current)
      return typeof saved?.text === 'string' && saved.text.length <= 32_000 ? saved.text : ''
    }
    const legacy = JSON.parse(localStorage.getItem('dcode.drafts') ?? 'null')
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return ''
    if (typeof legacy[key] === 'string' && legacy[key].length <= 32_000) fallback = legacy[key]
    for (const [name, text] of Object.entries(legacy).slice(-draftLimit)) {
      if (name.length >= 2048 || typeof text !== 'string' || !text || text.length > 32_000) continue
      if (localStorage.getItem(draftPrefix + name) === null)
        localStorage.setItem(draftPrefix + name, JSON.stringify({ text, updated: 0 }))
    }
    localStorage.removeItem('dcode.drafts')
  } catch { /* 浏览器空间不足时仍可读取旧格式中的当前草稿。 */ }
  return fallback
}

// 每份草稿独立写入，两个工作树同时输入时互不覆盖。
function storeDraft(key: string, text: string) {
  try {
    const name = draftPrefix + key
    if (!text) { localStorage.removeItem(name); return }
    const isNew = localStorage.getItem(name) === null
    localStorage.setItem(name, JSON.stringify({ text, updated: Date.now() }))
    if (!isNew) return
    const names = Object.keys(localStorage).filter(item => item.startsWith(draftPrefix) && item !== name)
    if (names.length < draftLimit) return
    const recent = names.map(item => ({ item, updated: Number(JSON.parse(localStorage.getItem(item) ?? 'null')?.updated) || 0 }))
    recent.sort((a, b) => a.updated - b.updated)
    for (const old of recent.slice(0, recent.length + 1 - draftLimit)) localStorage.removeItem(old.item)
  } catch { /* 空间不足时保留窗口内的草稿。 */ }
}

export function useDraft(key: string) {
  const cache = useRef(new Map<string, string>())
  const [current, setCurrent] = useState(() => ({ key, text: loadDraft(key) }))
  if (current.key !== key) setCurrent({ key, text: cache.current.get(key) ?? loadDraft(key) })
  function update(text: string) {
    cache.current.delete(key)
    if (cache.current.size >= draftLimit) cache.current.delete(cache.current.keys().next().value!)
    cache.current.set(key, text)
    storeDraft(key, text)
    setCurrent({ key, text })
  }
  return [current.text, update] as const
}
