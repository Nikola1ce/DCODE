// 键盘命令面板与有界文件搜索，原生 dialog 提供焦点约束。
// 制作人：Moriarty_Dox
import { useEffect, useRef, useState } from 'react'
import type { DocumentPreview } from './DocumentView.js'
import { unwrap, useAction, useResource } from './serviceHooks.js'
import { Icon } from './Icon.js'

export interface DesktopCommand { id: string; label: string; shortcut?: string; disabled?: boolean; run(): void | Promise<void> }

export function CommandPalette({ mode, commands, cwd, close, open }: {
  mode: 'commands' | 'files'; commands: DesktopCommand[]; cwd: string | null
  close(): void; open(document: DocumentPreview): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(0)
  const action = useAction()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => { const timer = setTimeout(() => setSearch(query), 200); return () => clearTimeout(timer) }, [query])
  const resourceKey = `${mode}:${cwd}:${search}`
  const files = useResource(resourceKey, () => mode === 'files' && cwd ? unwrap(window.dcode.searchFiles(search)) : Promise.resolve({ entries: [], truncated: false }))
  const searching = mode === 'files' && !!cwd && (query !== search || files.loading || (!files.error && files.resolvedKey !== resourceKey))
  const choices: DesktopCommand[] = mode === 'commands' ? commands.filter((item) => item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    : (searching || files.resolvedKey !== resourceKey ? [] : files.value?.entries ?? []).map((file) => ({ id: file.path, label: file.path, run: async () => {
      const preview = await unwrap(window.dcode.readFile(file.path))
      open({ title: file.path, text: preview.kind === 'text' ? preview.text : `二进制文件 · ${preview.size} 字节`, truncated: preview.kind === 'text' && preview.truncated })
    } }))
  useEffect(() => { setSelected((index) => Math.max(0, Math.min(index, choices.length - 1))) }, [choices.length])
  useEffect(() => { dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  async function execute(item: DesktopCommand | undefined) {
    if (!item || item.disabled || action.busy) return
    await action.run(async () => { await item.run(); close() })
  }
  return <dialog ref={dialog} className="command-palette" aria-label={mode === 'files' ? '快速打开文件' : '命令面板'} onCancel={(event) => { event.preventDefault(); close() }}
    onClick={(event) => { if (event.target === dialog.current) close() }}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.nativeEvent.isComposing) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected((index) => Math.max(0, Math.min(choices.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
      }
      if (event.key === 'Enter' && ((event.target as HTMLElement).tagName === 'INPUT' || (event.target as HTMLElement).closest('[role="option"]'))) { event.preventDefault(); void execute(choices[selected]) }
    }}>
    <div className="palette-content"><div className="palette-input-row"><Icon name={searching ? 'refresh' : 'search'} size={20} className={searching ? 'spin' : ''} /><input autoFocus role="combobox" aria-expanded="true" aria-controls="palette-options" aria-activedescendant={choices[selected] ? `palette-option-${selected}` : undefined} aria-autocomplete="list" aria-label={mode === 'files' ? '搜索文件路径' : '搜索命令'} placeholder={mode === 'files' ? '输入文件名或路径…' : '搜索命令…'} value={query}
      onChange={(event) => { setQuery(event.target.value); setSelected(0) }} /><kbd>Esc</kbd></div>
      {mode === 'files' && !cwd && <p className="empty-panel">请先选择项目文件夹。</p>}
      {(action.error || files.error) && <p className="inline-error" role="alert">{action.error || files.error}{files.error && <button onClick={files.refresh}>重试搜索</button>}</p>}
      <div className="palette-list" id="palette-options" role="listbox" aria-label="搜索结果">{choices.map((item, index) => <button id={`palette-option-${index}`} role="option" aria-selected={selected === index} key={item.id} disabled={item.disabled || action.busy}
        className={selected === index ? 'selected' : ''} onFocus={() => setSelected(index)} onMouseMove={() => setSelected(index)} onClick={() => void execute(item)}><Icon name={mode === 'files' ? 'files' : 'terminal'} size={16} /><span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}</div>
      {files.value?.truncated && <p className="muted small">显示前 200 项，目录扫描上限 10,000 项，请输入更具体的路径。</p>}
      {!choices.length && <p className="empty-panel" role="status">{searching ? '正在搜索…' : '没有匹配项'}</p>}
      <div className="palette-footer">↑ ↓ 选择 · Enter 执行 · Esc 关闭<button onClick={close}>关闭</button></div>
    </div>
  </dialog>
}
