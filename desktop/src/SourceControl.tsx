// 源代码管理：暂存分组、路径筛选、批量索引操作、提交与真实父提交拓扑。
// 制作人：Moriarty_Dox
import { useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import type { GitBranchInput, GitEntry, GitRemoteInput } from '../shared/services.js'
import type { DocumentPreview } from './DocumentView.js'
import { commitGraph } from './diffModel.js'
import { unwrap, useAction, useDraft, useResource } from './serviceHooks.js'
import { Icon } from './Icon.js'
import { ContextMenu } from './ContextMenu.js'
import type { MenuAction, MenuPosition } from './ContextMenu.js'
import { GitBranchDialog } from './GitBranchDialog.js'

type MenuTarget =
  | { kind: 'repository' }
  | { kind: 'file'; entry: GitEntry; staged: boolean }
  | { kind: 'group'; staged: boolean }
  | { kind: 'commit'; hash: string }

export function SourceControl({ cwd, revision, locked, open }: {
  cwd: string; revision: number; locked: boolean; open(document: DocumentPreview): void
}) {
  const status = useResource(String(revision), () => unwrap(window.dcode.gitStatus()))
  const history = useResource(String(revision), () => unwrap(window.dcode.gitHistory()))
  const branches = useResource(String(revision), () => unwrap(window.dcode.gitBranches()))
  function refresh() { status.refresh(); history.refresh(); branches.refresh() }
  const action = useAction()
  function mutate(operation: () => Promise<unknown>) {
    return action.run(async () => {
      try { await operation() }
      finally { refresh() }
    })
  }
  const [branchDialog, setBranchDialog] = useState<'list' | 'create' | null>(null)
  const [menu, setMenu] = useState<(Omit<MenuPosition, 'items'> & { target: MenuTarget }) | null>(null)
  const [remoteChoice, setRemoteChoice] = useState('')
  const [operation, setOperation] = useState('')
  const [message, setMessage] = useDraft(`git:${cwd}`)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState('')
  const [feedback, setFeedback] = useState('')
  const entries = status.value?.entries ?? []
  const conflicts = entries.filter((entry) => entry.index === 'U' || entry.worktree === 'U' || ['AA', 'DD'].includes(entry.index + entry.worktree))
  const staged = entries.filter((entry) => !['.', '?'].includes(entry.index) && !conflicts.includes(entry))
  const changes = entries.filter((entry) => entry.worktree !== '.' && !conflicts.includes(entry))
  const busy = locked || action.busy || status.loading
  const graph = useMemo(() => commitGraph(history.value ?? []), [history.value])
  const currentBranch = branches.value?.branches.find(branch => branch.current)
  const remotes = branches.value?.remotes ?? []
  const remote = remotes.includes(remoteChoice) ? remoteChoice : remotes.find(name => name === currentBranch?.remoteName) ?? remotes.find(name => name === 'origin') ?? remotes[0] ?? ''
  const remoteBusy = busy || branches.loading || !branches.value || !remote
  const trackingMismatch = !!currentBranch?.upstream && currentBranch.remoteName !== remote

  function showMenu(event: MouseEvent, target: MenuTarget) {
    event.preventDefault(); event.stopPropagation()
    const bounds = event.currentTarget.getBoundingClientRect()
    setMenu({ x: event.clientX || bounds.left + 12, y: event.clientY || bounds.bottom, target })
  }
  function openDiff(entry: GitEntry, isStaged: boolean) {
    void action.run(async () => {
      const diff = await unwrap(window.dcode.gitDiff(entry.path, isStaged))
      setSelected(`${isStaged}:${entry.path}`)
      open({ title: `${entry.path} · ${isStaged ? '暂存区' : '工作区'}`, ...diff, diff: true, reload: () => unwrap(window.dcode.gitDiff(entry.path, isStaged)) })
    })
  }
  function fileMenu(entry: GitEntry, isStaged: boolean): MenuAction[] {
    return [
      { label: '打开差异', disabled: action.busy, run: () => openDiff(entry, isStaged) },
      { label: '打开文件', disabled: action.busy || entry.worktree === 'D' || entry.index === 'D', run: () => void action.run(async () => {
        const file = await unwrap(window.dcode.readFile(entry.path))
        open({ title: entry.path, text: file.kind === 'text' ? file.text : `二进制文件 · ${file.size} 字节`, truncated: file.kind === 'text' && file.truncated })
      }) },
      { label: '复制相对路径', run: () => void action.run(async () => { await navigator.clipboard.writeText(entry.path); setFeedback('已复制文件路径') }) },
      { label: isStaged ? '取消暂存' : '暂存更改', disabled: busy, run: () => void mutate(() => unwrap(window.dcode.gitStage(entry.path, !isStaged))) },
      ...(!isStaged ? [{ label: '放弃更改', danger: true, disabled: busy, run: () => void mutate(() => unwrap(window.dcode.gitDiscard(entry.path))) }] : []),
    ]
  }
  function performBranch(input: GitBranchInput) {
    void mutate(async () => {
      if (await unwrap(window.dcode.gitBranch(input))) {
        setBranchDialog(null); setRemoteChoice(''); setSelected('')
        setFeedback({ switch: '已切换分支', create: '已创建并切换分支', rename: '已重命名分支', delete: '已删除本地分支' }[input.action])
      }
    })
  }
  function remoteOperation(kind: GitRemoteInput['action']) {
    if (remoteBusy || !branches.value) return
    const labels = { fetch: '获取', pull: '拉取', push: currentBranch?.upstream ? '推送' : '发布分支' }
    void mutate(async () => {
      setFeedback(''); setOperation(`正在${labels[kind]} · ${remote}`)
      try {
        await unwrap(window.dcode.gitRemote({ action: kind, remote, revision: branches.value!.revision }))
        setFeedback(`${labels[kind]}完成 · ${remote}`)
      } finally { setOperation('') }
    })
  }
  function repositoryMenu(): MenuAction[] {
    return [
      { label: '切换 / 管理分支', disabled: busy || branches.loading || !branches.value, run: () => setBranchDialog('list') },
      { label: '创建分支…', disabled: busy || branches.loading || !branches.value, run: () => setBranchDialog('create') },
      { label: '获取远程更新', disabled: remoteBusy, run: () => remoteOperation('fetch') },
      { label: '拉取（快进）', disabled: remoteBusy || trackingMismatch || !currentBranch?.upstream, run: () => remoteOperation('pull') },
      { label: currentBranch?.upstream ? '推送' : '发布分支', disabled: remoteBusy || trackingMismatch || !branches.value?.head || !branches.value.current, run: () => remoteOperation('push') },
      { label: '刷新', disabled: action.busy, run: refresh },
    ]
  }

  function menuItems(target: MenuTarget): MenuAction[] {
    if (target.kind === 'repository') return repositoryMenu()
    if (target.kind === 'file') return fileMenu(target.entry, target.staged)
    if (target.kind === 'group') return [{ label: target.staged ? '取消全部暂存' : '暂存所有更改', disabled: busy || !(target.staged ? staged : changes).length,
      run: () => void mutate(() => unwrap(window.dcode.gitStageAll(!target.staged))) }]
    return [{ label: '复制提交 SHA', run: () => void action.run(async () => { await navigator.clipboard.writeText(target.hash); setFeedback('已复制提交 SHA') }) }]
  }

  async function commit() {
    if (busy || !message.trim() || !staged.length || !status.value?.revision) return
    await mutate(async () => {
      const hash = await unwrap(window.dcode.gitCommit(message, status.value!.revision!))
      setMessage('')
      setFeedback(`已提交 ${hash.slice(0, 8)}`)
    })
  }

  function group(title: string, items: GitEntry[], isStaged: boolean) {
    const filtered = items.filter((entry) => entry.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
    return <details className="scm-group" open>
      <summary onContextMenu={event => showMenu(event, { kind: 'group', staged: isStaged })}><span>{title}</span><span className="group-actions">
        <button className="icon-button" disabled={busy || !items.length} title={isStaged ? '取消全部暂存' : '暂存所有更改'} aria-label={isStaged ? '取消全部暂存' : '暂存所有更改'}
          onClick={(event) => { event.preventDefault(); void mutate(() => unwrap(window.dcode.gitStageAll(!isStaged))) }}><Icon name={isStaged ? 'minus' : 'plus'} size={15} /></button>
        <span className="count">{items.length}</span></span></summary>
      {filtered.map((entry) => <div key={entry.path} className={`scm-file ${selected === `${isStaged}:${entry.path}` ? 'selected' : ''}`} onContextMenu={event => showMenu(event, { kind: 'file', entry, staged: isStaged })}>
        <button className="file-label" disabled={action.busy} title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}
          onClick={() => openDiff(entry, isStaged)}>
          <span className="file-symbol"><Icon name="files" size={14} /></span><span className="file-name">{entry.path.split('/').at(-1)}</span>
          <span className="file-directory">{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''}</span>
        </button>
        <div className="file-actions">
          {!isStaged && <button className="icon-button" title="放弃更改" aria-label={`放弃 ${entry.path} 的更改`} disabled={busy}
            onClick={() => void mutate(() => unwrap(window.dcode.gitDiscard(entry.path)))}><Icon name="undo" size={14} /></button>}
          <button className="icon-button" title={isStaged ? '取消暂存' : '暂存更改'} aria-label={`${isStaged ? '取消暂存' : '暂存'} ${entry.path}`} disabled={busy}
            onClick={() => void mutate(() => unwrap(window.dcode.gitStage(entry.path, !isStaged)))}><Icon name={isStaged ? 'minus' : 'plus'} size={15} /></button>
        </div>
        <span className={`git-letter git-${isStaged ? entry.index : entry.worktree}`}>{isStaged ? entry.index : entry.worktree === '?' ? 'U' : entry.worktree}</span>
      </div>)}
      {!items.length && <p className="group-empty">{isStaged ? '尚未暂存文件' : '工作区没有更改'}</p>}
      {!!items.length && !filtered.length && <p className="group-empty">没有匹配的文件</p>}
    </details>
  }

  return <div className="source-control" onContextMenu={event => {
    if ((event.target as Element).closest('input, textarea, select, dialog, [contenteditable="true"]')) return
    showMenu(event, { kind: 'repository' })
  }}>
    {menu && <ContextMenu menu={{ ...menu, items: menuItems(menu.target) }} close={() => setMenu(null)} />}
    {branchDialog && branches.value && <GitBranchDialog listing={branches.value} initialCreate={branchDialog === 'create'} busy={busy || branches.loading} error={action.error} close={() => setBranchDialog(null)} perform={performBranch} />}
    <div className="panel-heading"><h2>源代码管理</h2><div className="scm-heading-actions"><button className="icon-button" aria-label="刷新源代码管理" title="刷新" disabled={action.busy}
      onClick={refresh}><Icon name="refresh" size={16} className={status.loading ? 'spin' : ''} /></button><button className="icon-button" aria-label="更多源代码管理操作" title="更多操作" onClick={event => showMenu(event, { kind: 'repository' })}><Icon name="more" size={17} /></button></div></div>
    {status.error && <p className="inline-error" role="alert">{status.error}</p>}
    {status.value && <>
      <div className="scm-repository"><button className="branch-trigger" aria-label="切换分支" title="切换或管理分支" disabled={busy || branches.loading || !branches.value} onClick={() => setBranchDialog('list')}><Icon name="git" size={15} /><span className="truncate">{status.value.branch === '(detached)' ? '分离 HEAD' : status.value.branch}</span><Icon name="chevron" size={12} /></button>
        {status.value.upstream && <span className="muted">↑{status.value.ahead ?? 0} ↓{status.value.behind ?? 0}</span>}</div>
      {branches.error && <p className="inline-error" role="alert">{branches.error}<button onClick={branches.refresh}>重试</button></p>}
      <div className="scm-remote">
        {remotes.length > 0 ? <><div className="remote-actions"><select aria-label="Git 远程" value={remote} disabled={action.busy} onChange={event => setRemoteChoice(event.target.value)}>{remotes.map(name => <option key={name}>{name}</option>)}</select>
          <button className="icon-button" aria-label="获取远程更新" title="获取远程更新" disabled={remoteBusy} onClick={() => remoteOperation('fetch')}><Icon name="refresh" size={15} /></button>
          <button className="icon-button" aria-label="拉取远程更新" title="拉取（仅快进）" disabled={remoteBusy || trackingMismatch || !currentBranch?.upstream} onClick={() => remoteOperation('pull')}><Icon name="down" size={16} /></button>
          <button className="icon-button" aria-label={currentBranch?.upstream ? '推送当前分支' : '发布当前分支'} title={currentBranch?.upstream ? '推送当前分支' : '发布分支并设置跟踪关系'} disabled={remoteBusy || trackingMismatch || !branches.value?.head || !branches.value.current} onClick={() => remoteOperation('push')}><Icon name="arrow" size={16} /></button></div>
          <p className="remote-tracking" title={currentBranch?.upstream}>{trackingMismatch ? '请选择当前分支对应的远程进行拉取或推送' : currentBranch?.upstream ? `跟踪 ${currentBranch.upstream}` : '发布当前分支以建立远程跟踪'}</p></>
          : !branches.loading && <p className="remote-tracking">仓库尚未配置远程，可在系统 Git 中添加。</p>}
      </div>
      {operation && <p className="scm-operation" role="status"><Icon name="refresh" className="spin" size={14} />{operation}</p>}
      <div className="scm-inputs">
        <textarea aria-label="提交消息" value={message} maxLength={8000} rows={3} placeholder={`消息（Ctrl+Enter 在“${status.value.branch}”提交）`}
          onChange={(event) => { setMessage(event.target.value); setFeedback('') }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void commit() }
          }} />
        <button className="primary commit-button" disabled={busy || !message.trim() || !staged.length || !!conflicts.length} onClick={() => void commit()}><Icon name={action.busy ? 'refresh' : 'check'} size={16} className={action.busy ? 'spin' : ''} />{action.busy ? '处理中…' : '提交'}</button>
        <input aria-label="筛选更改文件" placeholder="筛选文件…" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      {feedback && <p className="success-message" role="status">{feedback}</p>}
      {action.error && <p className="inline-error" role="alert">{action.error}</p>}
      <div className="scm-changes">
        {!!conflicts.length && <details className="scm-group" open><summary>合并冲突 <span className="count">{conflicts.length}</span></summary>
          {conflicts.map((entry) => <div className="conflict-file" key={entry.path}>{entry.path}</div>)}
          <p className="group-empty">请在编辑器解决冲突后刷新。</p></details>}
        {group('暂存的更改', staged, true)}
        {group('更改', changes, false)}
      </div>
      <details className="history-panel" open><summary>图表 <span className="muted small">最近 100 条</span></summary>
        {history.error && <p className="inline-error">{history.error}</p>}
        {history.value?.map((entry, index) => <button key={entry.hash} className="commit-row" title={`${entry.subject}\n${entry.author} · ${new Date(entry.timestamp).toLocaleString()}\n${entry.hash}`}
          onContextMenu={event => showMenu(event, { kind: 'commit', hash: entry.hash })}
          onClick={() => void action.run(async () => {
            const diff = await unwrap(window.dcode.gitCommitDiff(entry.hash))
            open({ title: `${entry.hash.slice(0, 8)} · ${entry.subject}`, ...diff, diff: true })
          })}>
          <svg width={graph[index].width * 14 + 8} height="32" className="commit-graph" aria-hidden="true">
            {graph[index].edges.map((edge, edgeIndex) => <path key={edgeIndex} d={`M ${edge.from * 14 + 8} 0 L ${edge.from * 14 + 8} 16 L ${edge.to * 14 + 8} 32`} />)}
            <circle cx={graph[index].column * 14 + 8} cy="16" r="4" />
          </svg>
          <span className="commit-subject">{entry.subject}</span><span className="commit-author">{entry.author}</span>
          {entry.refs && <span className="ref-badge">{entry.refs.replace('HEAD -> ', '')}</span>}
        </button>)}
        {history.value?.length === 0 && <p className="group-empty">首次提交后显示记录</p>}
      </details>
    </>}
    {status.loading && !status.value && <div className="loading-skeleton" aria-label="正在读取仓库"><i /><i /><i /></div>}
  </div>
}
