import { useEffect, useRef, useState } from 'react'
import type { ManagedWorktree, WorktreeInput } from '../shared/services.js'
import { unwrap, useResource } from './serviceHooks.js'
import { Icon } from './Icon.js'

export function WorktreeDialog({ close }: { close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const listing = useResource('worktrees', () => unwrap(window.dcode.listWorktrees()))
  const [selected, select] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ file: string; text: string; revision: string } | null>(null)
  const tree = listing.value?.find(item => item.id === selected) ?? listing.value?.[0]
  const disabled = busy || listing.loading
  useEffect(() => { dialog.current?.showModal() }, [])
  async function act(tree: ManagedWorktree, action: WorktreeInput['action'], path?: string) {
    setBusy(true); setResult(''); setError('')
    try {
      const message = await unwrap(window.dcode.manageWorktree({ id: tree.id, revision: tree.revision, action, ...(path && { path }) }))
      if (action === 'preview') setPreview({ file: path!, text: message, revision: tree.revision })
      else { setResult(message); setPreview(null) }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '工作树操作失败。') }
    finally { setBusy(false); if (action !== 'preview') listing.refresh() }
  }
  return <dialog className="branch-dialog worktree-dialog" ref={dialog} aria-label="管理并行工作树" onKeyDown={e => e.stopPropagation()} onCancel={e => { e.preventDefault(); if (!busy) close() }}>
    <header><h2>并行工作树</h2><button className="icon-button" aria-label="关闭工作树管理" disabled={busy} onClick={close}><Icon name="close" /></button></header>
    <div className="worktree-toolbar">
      {tree && <select aria-label="选择工作树" value={tree.id} disabled={disabled} onChange={e => { select(e.target.value); setPreview(null); setResult(''); setError('') }}>{listing.value?.map(item => <option key={item.id} value={item.id}>{item.branch ?? item.id}</option>)}</select>}
      <button disabled={disabled} onClick={listing.refresh}>刷新</button>
    </div>
    {(error || listing.error) && <p className="inline-error" role="alert">{error || listing.error}</p>}
    {result && <p className="inline-notice" role="status">{result}</p>}
    {tree ? <section className="worktree-detail">
      <p>目标分支 <strong>{tree.base ?? '尚未选择分支'}</strong> · 领先 {tree.ahead} 个提交 · 落后 {tree.behind} 个提交</p>
      <p className="muted small">{tree.id} · {tree.merging ? '合并进行中' : tree.dirty ? '有未提交修改' : '工作目录干净'}</p>
      <div className="row-actions"><button disabled={disabled} onClick={() => void act(tree, 'open')}>打开窗口</button>
        <button disabled={disabled || !tree.base || !tree.behind || tree.dirty || tree.merging} onClick={() => void act(tree, 'sync')}>同步基线</button>
        <button className="primary" disabled={disabled || !tree.base || !tree.ahead || !!tree.behind || tree.dirty || tree.merging} onClick={() => void act(tree, 'integrate')}>合并回目标分支</button>
        <button disabled={disabled || !tree.base || !!tree.ahead || tree.dirty || tree.merging} onClick={() => void act(tree, 'remove')}>清理工作树</button></div>
      {tree.merging && <><h3>合并冲突（{tree.conflicts.length}）</h3>{tree.conflicts.map(file => <div className="worktree-conflict" key={file}><strong>{file}</strong><div className="row-actions">
        <button disabled={disabled} onClick={() => void act(tree, 'preview', file)}>查看差异</button>
        <button disabled={disabled} onClick={() => void act(tree, 'ours', file)}>采用工作树版本</button>
        <button disabled={disabled} onClick={() => void act(tree, 'theirs', file)}>采用合入版本</button>
        <button disabled={disabled} onClick={() => void act(tree, 'resolved', file)}>已手动解决</button>
      </div>{preview?.revision === tree.revision && preview.file === file && <pre>{preview.text}</pre>}</div>)}
      <div className="row-actions"><button className="primary" disabled={disabled || !!tree.conflicts.length} onClick={() => void act(tree, 'finish')}>完成合并提交</button>
      <button disabled={disabled} onClick={() => void act(tree, 'abort')}>中止合并</button></div></>}
    </section> : !listing.error && <p className="empty-panel">{listing.loading ? '正在读取工作树…' : '此仓库还没有并行工作树。'}</p>}
  </dialog>
}
