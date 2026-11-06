// 分支选择与命名表单，使用真实分支快照提交操作并保留失败时的输入。
// 制作人：Moriarty_Dox
import { useEffect, useRef, useState } from 'react'
import type { GitBranch, GitBranches, GitBranchInput } from '../shared/services.js'
import { Icon } from './Icon.js'

export function GitBranchDialog({ listing, initialCreate, busy, error, close, perform }: {
  listing: GitBranches; initialCreate: boolean; busy: boolean; error: string
  close(): void; perform(input: GitBranchInput): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<'list' | 'create' | 'rename'>(initialCreate ? 'create' : 'list')
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [source, setSource] = useState<GitBranch | null>(null)
  const [startPoint, setStartPoint] = useState('')
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => { dialog.current?.querySelector<HTMLInputElement>('input')?.focus() }, [mode])
  function submit() {
    if (busy || !name.trim()) return
    if (mode === 'rename' && source) perform({ action: 'rename', name: source.ref, newName: name.trim(), revision: listing.revision })
    else perform({ action: 'create', name: name.trim(), ...(startPoint ? { startPoint } : {}), revision: listing.revision })
  }
  function branches(remote: boolean) {
    const items = listing.branches.filter(item => item.remote === remote && item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    if (!items.length) return null
    return <section className="branch-group"><h3>{remote ? '远程分支' : '本地分支'}</h3>{items.map(branch =>
      <div className="branch-row" key={branch.ref}>
        <button className="branch-choice" disabled={busy || branch.current || branch.checkedOut} title={branch.ref}
          onClick={() => perform({ action: 'switch', name: branch.ref, revision: listing.revision })}>
          <Icon name={branch.current ? 'check' : 'git'} size={16} /><span><strong>{branch.name}</strong><small>{branch.current ? '当前分支' : branch.checkedOut ? '其他工作树正在使用' : branch.upstream ?? (remote ? '创建本地跟踪分支' : '本地分支')}</small></span>
        </button>
        {!remote && <div className="branch-actions"><button disabled={busy || (branch.checkedOut && !branch.current)} aria-label={`重命名分支 ${branch.name}`} onClick={() => { setSource(branch); setName(branch.name); setMode('rename') }}>重命名</button>
          <button className="danger" aria-label={`删除分支 ${branch.name}`} disabled={busy || branch.current || branch.checkedOut}
            onClick={() => perform({ action: 'delete', name: branch.ref, revision: listing.revision })}>删除</button></div>}
      </div>)}</section>
  }
  return <dialog ref={dialog} className="branch-dialog" aria-label="分支管理" onCancel={event => { event.preventDefault(); if (!busy) close() }} onKeyDown={event => event.stopPropagation()}>
    <header><h2>{mode === 'list' ? '切换分支' : mode === 'create' ? '创建并切换分支' : '重命名分支'}</h2><button className="icon-button" aria-label="关闭分支管理" disabled={busy} onClick={close}><Icon name="close" /></button></header>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {mode === 'list' ? <><div className="branch-search"><input aria-label="搜索分支" placeholder="搜索本地或远程分支…" value={query} onChange={event => setQuery(event.target.value)} />
      <button disabled={busy} onClick={() => { setName(''); setMode('create') }}><Icon name="plus" size={15} />新建分支</button></div>
      <div className="branch-list">{branches(false)}{branches(true)}{!listing.branches.some(item => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="empty-panel">{listing.head ? '没有匹配的分支' : '首次提交后显示分支记录，可先创建新分支。'}</p>}</div></>
      : <form className="branch-form" onSubmit={event => { event.preventDefault(); submit() }}><label>分支名称<input aria-label="分支名称" required maxLength={200} value={name} disabled={busy} placeholder="feature/my-change" onChange={event => setName(event.target.value)} /></label>
        {mode === 'create' && <label>起始位置<select aria-label="起始分支" disabled={busy} value={startPoint} onChange={event => setStartPoint(event.target.value)}><option value="">当前 HEAD{listing.current ? ` · ${listing.current}` : ''}</option>{listing.branches.map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}</select></label>}
        <div className="row-actions"><button type="button" disabled={busy} onClick={() => setMode('list')}>返回列表</button><button className="primary" type="submit" disabled={busy || !name.trim()}>{busy ? '正在处理…' : mode === 'create' ? '创建并切换' : '保存名称'}</button></div></form>}
    {busy && <p className="branch-progress" role="status"><Icon name="refresh" className="spin" size={15} />正在更新分支…</p>}
  </dialog>
}
