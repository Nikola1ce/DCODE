// 复制按钮提供完成与失败反馈，保持浏览器剪贴板权限边界。
// 制作人：Moriarty_Dox
import { useEffect, useState } from 'react'
import { Icon } from './Icon.js'

export function CopyButton({ text, label = '复制', compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  useEffect(() => {
    if (status === 'idle') return
    const timer = setTimeout(() => setStatus('idle'), 2200)
    return () => clearTimeout(timer)
  }, [status])
  const title = status === 'copied' ? '已复制' : status === 'error' ? '复制失败，请选中文本后按 Ctrl+C' : label
  return <button type="button" className={`copy-button ${compact ? 'icon-button' : ''}`} aria-label={title} title={title} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setStatus('copied') }
    catch { setStatus('error') }
  }}><Icon name={status === 'copied' ? 'check' : status === 'error' ? 'info' : 'copy'} size={14} />{!compact && <span>{title}</span>}<span className="sr-only" role="status">{status !== 'idle' ? title : ''}</span></button>
}
