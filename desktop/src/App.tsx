// 桌面工作台：会话、资源管理器、源代码管理、审阅、用量与设置。
// 制作人：Moriarty_Dox
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import type { ConnectionPhase, DesktopEvent, Result } from '../shared/api.js'
import { INITIAL_CHAT_STATE, reduceEvents } from './state.js'
import type { DesktopPreferences, ModelSettings, SessionHistory } from '../shared/services.js'
import { CommandPalette } from './CommandPalette.js'
import type { DesktopCommand } from './CommandPalette.js'
import { DocumentView } from './DocumentView.js'
import type { DocumentPreview } from './DocumentView.js'
import { SourceControl } from './SourceControl.js'
import { FilesPanel, ProjectsPanel, ReviewPanel, ReviewEditor, SessionsPanel, UsagePanel } from './WorkspacePanels.js'
import { unwrap, useDraft } from './serviceHooks.js'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'
import { CopyButton } from './CopyButton.js'
import { SettingsPage, SettingsNavigation } from './SettingsPage.js'
import type { SettingsSection } from './SettingsPage.js'
import { useWorkspaceLayout } from './useWorkspaceLayout.js'

const PHASE_LABELS: Record<ConnectionPhase, string> = {
  disconnected: '未连接', starting: '连接中', ready: '就绪', running: '执行中',
  cancelling: '停止中', stopping: '关闭中', idle: '已空闲回收', recovering: '恢复会话中', failed: '连接失败',
}

export function App() {
  const [state, dispatch] = useReducer(reduceEvents, INITIAL_CHAT_STATE)
  const [panel, setPanel] = useState('sessions')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models')
  const previousPanel = useRef('sessions')
  const layout = useWorkspaceLayout()
  const [palette, setPalette] = useState<'commands' | 'files' | null>(null)
  const [configuration, setConfiguration] = useState<ModelSettings | null>(null)
  const [preview, setPreview] = useState<DocumentPreview | null>(null)
  const [revision, setRevision] = useState(0)
  const [preferences, setPreferences] = useState<DesktopPreferences>({ theme: 'system', sendKey: 'enter', notifications: true, preventSleep: true,
    closeBehavior: 'ask', notifyPermission: true, notifyComplete: true, notifyError: true })
  const [history, setHistory] = useState<SessionHistory>({ messages: [], truncated: false })
  const [historyLoading, setHistoryLoading] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const messages = useRef<HTMLElement>(null)
  const messageContent = useRef<HTMLDivElement>(null)
  const prompt = useRef<HTMLTextAreaElement>(null)
  const followOutput = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const loadedHistory = useRef<string | null>(null)
  const { snapshot, turns } = state
  const identity = `${snapshot.cwd}:${snapshot.sessionId}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  function openDocument(document: DocumentPreview) {
    if (currentIdentity.current === identity) {
      setPreview(document)
      if (panel === 'settings') navigate('files')
    }
  }
  const [draft, setDraft] = useDraft(`chat:${snapshot.cwd ?? ''}:${snapshot.sessionId ?? ''}`)
  const working = snapshot.phase === 'running' || snapshot.phase === 'cancelling'
  const connecting = ['starting', 'recovering', 'stopping'].includes(snapshot.phase)
  const canSend = snapshot.phase === 'ready' && snapshot.hasApiKey && !pending && !historyLoading && !!draft.trim()
  const locked = working || connecting || !!pending

  function navigate(next: string) {
    if (next !== 'settings') previousPanel.current = next
    setPanel(next)
    layout.expand()
  }
  function modelSettings() { setSettingsSection('models'); navigate('settings') }
  function latestMessage() {
    followOutput.current = true
    setShowLatest(false)
    messages.current?.scrollTo({ top: messages.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  function suggest(text: string) { setDraft(text); prompt.current?.focus() }

  useEffect(() => { setPreview(null) }, [snapshot.cwd, snapshot.sessionId])

  useEffect(() => {
    if (!window.dcode) { setError('请通过 Electron 启动桌面程序，而非直接打开 HTML。'); return }
    let active = true
    let frame = 0
    let receivedEvent = false
    const queue: DesktopEvent[] = []
    const flush = () => {
      frame = 0
      if (active) dispatch(queue.splice(0))
    }
    const unsubscribe = window.dcode.subscribe((event) => {
      receivedEvent = true
      queue.push(event)
      if (event.type === 'workspace_changed' || (event.type === 'stream' && ['turn_done', 'turn_error'].includes(event.message.type))) {
        setRevision((value) => value + 1)
      }
      if (event.type === 'workspace_watch_error') setError('文件监听已中断，可使用面板刷新按钮重新读取。')
      // 最小化窗口会暂停 rAF；达到上限立即消耗，避免隐藏窗口无限累积流式事件。
      if (queue.length >= 32) {
        cancelAnimationFrame(frame)
        flush()
      } else if (!frame) frame = requestAnimationFrame(flush)
    })
    void window.dcode.getSnapshot().then((result) => {
      if (!active || receivedEvent) return
      if (result.ok) dispatch([{ type: 'connection', snapshot: result.value }])
      else setError(`${result.error.code}：${result.error.message}`)
    }).catch(() => { if (active) setError('无法连接桌面主进程。') })
    return () => { active = false; unsubscribe(); cancelAnimationFrame(frame) }
  }, [])

  useEffect(() => {
    void unwrap(window.dcode.getSettings()).then(setPreferences).catch((reason: Error) => setError(reason.message))
    refreshConfiguration()
  }, [])

  function refreshConfiguration() {
    void unwrap(window.dcode.getModelSettings()).then(setConfiguration).catch((reason: Error) => setError(reason.message))
  }

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.dataset.theme = preferences.theme === 'system' ? media.matches ? 'dark' : 'light' : preferences.theme }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [preferences.theme])

  useEffect(() => {
    const identity = `${snapshot.cwd}:${snapshot.sessionId}`
    if (loadedHistory.current === identity || connecting) return
    setPreview(null)
    setHistory({ messages: [], truncated: false })
    if (!snapshot.sessionId) { setHistoryLoading(false); return }
    let active = true
    setHistoryLoading(true)
    void unwrap(window.dcode.getSessionHistory(snapshot.sessionId)).then((value) => {
      if (active) { loadedHistory.current = identity; setHistory(value) }
    }).catch((reason: Error) => { if (active) setError(reason.message) })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [snapshot.cwd, snapshot.sessionId, connecting])

  useEffect(() => {
    if (!snapshot.cwd || connecting) return
    void unwrap(window.dcode.watchWorkspace(true)).catch((reason: Error) => setError(reason.message))
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh) }
  }, [snapshot.cwd, connecting])

  useEffect(() => { followOutput.current = true; setShowLatest(false) }, [identity])
  useEffect(() => {
    const element = messages.current
    const content = messageContent.current
    if (!element || !content) return
    // Markdown 延后渲染、展开工具详情和输入框增高都会改变可见区域。
    const observer = new ResizeObserver(() => {
      if (followOutput.current && element.clientHeight) element.scrollTop = element.scrollHeight
    })
    observer.observe(element)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const element = messages.current
    if (element && followOutput.current) element.scrollTop = element.scrollHeight
  }, [turns, history, snapshot.permissions.length, preview, panel])
  useLayoutEffect(() => {
    const element = prompt.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }, [draft, preview, panel])

  async function run<T>(key: string, operation: () => Promise<Result<T>>): Promise<T | undefined> {
    setPending(key)
    setError(null)
    try {
      const result = await operation()
      if (!result.ok) { setError(`${result.error.code}：${result.error.message}`); return undefined }
      return result.value
    } catch {
      setError('桌面连接暂时不可用；没有自动重发任何消息。')
      return undefined
    } finally {
      setPending(null)
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault()
    if (!canSend) return
    followOutput.current = true
    setShowLatest(false)
    const result = await run('send', () => window.dcode.sendPrompt(draft))
    if (result) { setDraft(''); prompt.current?.focus() }
  }

  async function selectSession(id: string | null) {
    setPreview(null)
    if (panel === 'settings') navigate('sessions')
    if (id && id === snapshot.sessionId) return
    await unwrap(window.dcode.openSession(id))
    const next = await unwrap(window.dcode.getSnapshot())
    dispatch([{ type: 'connection', snapshot: next }])
    setRevision((value) => value + 1)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || palette) return
      const modifier = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (modifier && key === 'b') { event.preventDefault(); layout.toggle(); return }
      if (modifier && (key === 'k' || key === 'p')) {
        event.preventDefault(); setPalette(key === 'p' && !event.shiftKey ? 'files' : 'commands'); return
      }
      if (modifier && key === 'n') {
        event.preventDefault()
        if (snapshot.cwd && !locked) void run('new-session', async () => { await selectSession(null); return { ok: true, value: undefined } })
        return
      }
      if (modifier && event.shiftKey && key === 'r') { event.preventDefault(); navigate('review'); return }
      if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && snapshot.cwd && !locked) {
        event.preventDefault()
        void run('switch-session', async () => {
          const listing = await unwrap(window.dcode.listSessions(false))
          const index = listing.sessions.findIndex((session) => session.id === snapshot.sessionId)
          const next = listing.sessions[index + (event.key === 'ArrowUp' ? -1 : 1)]
          if (next) await selectSession(next.id)
          return { ok: true, value: undefined }
        })
        return
      }
      if (event.key === 'Escape' && panel === 'settings') { event.preventDefault(); navigate(previousPanel.current); return }
      if (event.key === 'Escape' && preview) { event.preventDefault(); setPreview(null); return }
      if (event.key === 'Escape' && snapshot.phase === 'running' && !pending) {
        event.preventDefault()
        void run('cancel', () => window.dcode.cancelTurn())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snapshot.phase, snapshot.cwd, snapshot.sessionId, pending, palette, preview, locked, panel])

  const commands: DesktopCommand[] = [
    { id: 'project', label: '打开项目文件夹', run: async () => { await unwrap(window.dcode.chooseWorkspace()) }, disabled: locked },
    { id: 'new', label: '新建会话', shortcut: 'Ctrl+N', run: () => selectSession(null), disabled: locked || !snapshot.cwd },
    { id: 'reconnect', label: '重新连接当前会话', run: async () => { await unwrap(window.dcode.reconnect()) }, disabled: locked || !snapshot.cwd },
    { id: 'cancel', label: '停止当前回合', shortcut: 'Esc', run: async () => { await unwrap(window.dcode.cancelTurn()) }, disabled: snapshot.phase !== 'running' },
    ...([['sessions', '查看会话'], ['files', '资源管理器'], ['git', '源代码管理'], ['review', '文件审阅'], ['usage', '会话用量'], ['settings', '设置 / 供应商 / 模型 / 推理强度']] as const)
      .map(([id, label]) => ({ id, label, run: () => navigate(id) })),
    { id: 'sidebar', label: '展开 / 收起侧栏', shortcut: 'Ctrl+B', run: layout.toggle },
  ]

  return (
    <div className={`workspace-shell ${layout.collapsed ? 'sidebar-collapsed' : ''} ${layout.dragging ? 'resizing' : ''}`} style={{ '--sidebar-width': `${layout.width}px` } as CSSProperties}>
      <header className="app-toolbar">
        <div className="brand"><span className="brand-mark">D</span><strong>DCODE</strong><span className="brand-separator" /><span className="toolbar-project">{snapshot.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? '工作台'}</span></div>
        <button className="command-trigger" aria-label="打开命令面板" onClick={() => setPalette('commands')}><Icon name="search" size={15} /><span>搜索命令或快速操作</span><kbd>Ctrl K</kbd></button>
        <div className="toolbar-actions"><button className="icon-button" aria-label="切换侧栏" aria-expanded={!layout.collapsed} title="切换侧栏 Ctrl+B" onClick={layout.toggle}><Icon name="sidebar" /></button></div>
      </header>
      {palette && <CommandPalette key={`${palette}:${snapshot.cwd}`} mode={palette} commands={commands} cwd={snapshot.cwd} close={() => setPalette(null)} open={openDocument} />}
      <nav className="activity-bar" aria-label="工作台导航">
        {([['projects', '最近项目', 'projects'], ['sessions', '对话', 'chat'], ['files', '资源管理器', 'files'], ['git', '源代码管理', 'git'], ['review', '文件审阅', 'review'], ['usage', '会话用量', 'usage'], ['settings', '设置', 'settings']] as const).map(([id, label, icon]) =>
          <button key={id} aria-label={label} aria-pressed={panel === id} className={panel === id ? 'active' : ''} onClick={() => navigate(id)}><Icon name={icon} size={21} /><span className="nav-tooltip">{label}</span></button>)}
      </nav>
      <aside className="sidebar">
        <div className="project-switcher"><button className="project-name" title={snapshot.cwd ?? '选择项目文件夹'} disabled={locked}
          onClick={() => void run('choose', () => window.dcode.chooseWorkspace())}><Icon name="projects" size={17} /><span className="truncate">{snapshot.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? '打开项目'}</span><Icon name="chevron" size={14} /></button>
          {snapshot.cwd && <button className="icon-button" title={snapshot.phase === 'idle' ? '唤醒内核' : '重新连接'} aria-label="重新连接" disabled={locked}
            onClick={() => void run('reconnect', () => window.dcode.reconnect())}><Icon name="refresh" size={16} className={connecting ? 'spin' : ''} /></button>}</div>
        <div className="panel-content" key={snapshot.cwd}>
          {panel === 'settings' ? <SettingsNavigation section={settingsSection} select={setSettingsSection} />
            : panel === 'projects' || !snapshot.cwd ? <ProjectsPanel locked={locked} revision={revision} />
            : connecting ? <div className="loading-skeleton" aria-label="正在连接项目"><i /><i /><i /></div>
            : panel === 'git' ? <SourceControl cwd={snapshot.cwd} revision={revision} locked={locked} open={openDocument} />
            : panel === 'files' ? <FilesPanel revision={revision} open={openDocument} />
            : panel === 'review' && snapshot.sessionId ? <ReviewPanel key={snapshot.sessionId} sessionId={snapshot.sessionId} revision={revision} open={openDocument} />
            : panel === 'usage' && snapshot.sessionId ? <UsagePanel sessionId={snapshot.sessionId} revision={revision} />
            : <SessionsPanel revision={revision} locked={locked} sessionId={snapshot.sessionId} select={selectSession} />}
        </div>
        <div className="sidebar-bottom muted small" title={snapshot.cwd ?? ''}><Icon name="projects" size={13} /><span className="truncate">{snapshot.cwd ?? '打开项目以开始'}</span></div>
        <div className="sidebar-resizer" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={420} aria-valuenow={layout.width} tabIndex={layout.collapsed ? -1 : 0} {...layout.separator}
          onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); layout.resize(layout.width + (event.key === 'ArrowLeft' ? -16 : 16)) } }} />
      </aside>

      <main className="main-area">
        {panel === 'settings' && <SettingsPage section={settingsSection} locked={locked} saved={refreshConfiguration} preferences={preferences} update={async (patch) => setPreferences(await unwrap(window.dcode.updateSettings(patch)))} close={() => navigate(previousPanel.current)} />}
        <div className="editor-surface" hidden={panel === 'settings'}>
        <div className="editor-tabs"><button className={!preview ? 'active' : ''} onClick={() => setPreview(null)}>项目对话{snapshot.permissions.length ? ` · ${snapshot.permissions.length} 项待授权` : ''}</button>
          {preview && <div className="editor-tab active"><Icon name="files" size={14} /><span>{preview.title}</span><button className="icon-button" title="关闭预览 Esc" aria-label="关闭预览" onClick={() => setPreview(null)}><Icon name="close" size={14} /></button></div>}
          <button className="new-conversation icon-button" aria-label="新建项目对话" title="新建会话 Ctrl+N" disabled={locked || !snapshot.cwd} onClick={() => void run('new-session', async () => { await selectSession(null); return { ok: true, value: undefined } })}><Icon name="plus" size={17} /></button></div>
        {preview && (preview.review ? <ReviewEditor key={preview.review.checkpointId} {...preview.review} locked={locked} revision={revision} />
          : <DocumentView key={preview.title} document={preview} revision={revision} />)}
        <div className="conversation" hidden={!!preview}>
        <header className="conversation-header">
          <div><h1>{snapshot.cwd ? '项目对话' : '开始使用 DCODE'}</h1>
          </div>
          <span className={`status status-${snapshot.phase}`} role="status">{PHASE_LABELS[snapshot.phase]}</span>
        </header>
        <div className="notices">
          {error && <div className="notice error" role="alert"><Icon name="info" size={16} /><span>{error}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setError(null)}><Icon name="close" size={14} /></button></div>}
          {snapshot.error && <div className="notice error" role="alert"><strong>{snapshot.error.code}</strong>：{snapshot.error.message}
            {snapshot.phase === 'ready' && ' 会话进程已重新连接，请检查上一轮后手动继续。'}
          </div>}
          {snapshot.compatibilityWarning && <div className="notice">{snapshot.compatibilityWarning.code}：{snapshot.compatibilityWarning.message}</div>}
          {snapshot.phase === 'ready' && !snapshot.hasApiKey && <div className="notice"><Icon name="bolt" size={16} /><span>连接模型后即可发送消息</span><button onClick={modelSettings}>配置连接<Icon name="right" size={14} /></button></div>}
        </div>

        <section className="messages" aria-label="对话消息" ref={messages} onScroll={(event) => {
          const element = event.currentTarget
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
          followOutput.current = nearBottom
          setShowLatest(!nearBottom)
        }}>
          <div ref={messageContent} className="message-content">
          {historyLoading && <div className="loading-skeleton" aria-label="正在加载会话历史"><i /><i /><i /></div>}
          {history.truncated && <p className="inline-notice">当前显示最近的部分历史内容。</p>}
          {history.messages.map((message) => <div key={message.id} className={`message ${message.role}`}><div className="message-label">{message.role === 'user' ? '你' : <><span className="assistant-mark">D</span>DCODE</>}<CopyButton text={message.text} label="复制消息" compact /></div>{message.role === 'user' ? <p className="preserve">{message.text}</p> : <Markdown text={message.text} />}</div>)}
          {turns.length === 0 && !history.messages.length && !historyLoading && <div className="welcome">
            <div className="welcome-mark"><Icon name="terminal" size={30} /></div>
            <h2>{snapshot.cwd ? '今天，想完成什么？' : '从一个项目开始。'}</h2>
            <p>{snapshot.cwd ? '把想法、问题或待办交给 DCODE。' : '打开你的项目，让代码、对话和每一次改动都有上下文。'}</p>
            {snapshot.cwd ? <div className="suggestions">{([
              ['files', '了解这个项目', '梳理结构与关键模块', '请梳理这个项目的目录结构、技术栈和核心模块，并说明如何运行。'],
              ['terminal', '一起排查问题', '找到原因与修复方向', '请先检查项目结构和现有测试，帮我排查当前可能存在的问题。'],
              ['git', '检查当前改动', '审阅差异与潜在风险', '请审阅当前 Git 更改，检查潜在问题并给出修改建议。'],
            ] as const).map(([icon, title, detail, text]) => <button key={title} onClick={() => suggest(text)}><Icon name={icon} size={20} /><strong>{title}</strong><span>{detail}</span><Icon name="right" size={14} /></button>)}</div>
              : <div className="setup-guide"><button className="primary" disabled={locked} onClick={() => void run('choose', () => window.dcode.chooseWorkspace())}><Icon name="projects" size={18} />打开项目文件夹</button><button className="text-button" onClick={modelSettings}><Icon name="bolt" size={16} />{configuration?.providers.find((item) => item.id === configuration.provider)?.hasApiKey ? '管理模型连接' : '配置模型连接'}<Icon name="right" size={14} /></button></div>}
          </div>}
          {turns.map((turn) => <article className="turn" key={turn.requestId}>
            <div className="message user"><div className="message-label">你<CopyButton text={turn.prompt} label="复制消息" compact /></div><p className="preserve">{turn.prompt}</p></div>
            <div className="message assistant"><div className="message-label"><span className="assistant-mark">D</span>DCODE{turn.status === 'running' && <span className="working-label"><i />正在处理</span>}{turn.text && <CopyButton text={turn.text} label="复制回复" compact />}</div>
              {turn.reasoning && <details><summary>推理过程</summary><pre>{turn.reasoning}</pre></details>}
              {!!turn.tools.length && <div className="tool-list">{turn.tools.map((tool) => <details className={`tool-card ${tool.failed ? 'failed' : ''}`} key={tool.id}><summary><Icon name="terminal" size={16} /><span>{tool.summary}</span><Icon name="chevron" size={14} /></summary><pre>{tool.summary}</pre></details>)}</div>}
              {turn.text ? <Markdown text={turn.text} /> : turn.status === 'running' ? <div className="thinking-dots" role="status" aria-label="等待模型响应"><i /><i /><i /></div> : <p className="muted small">本轮没有文本输出。</p>}
              {turn.error && <p className="failed" role="alert">{turn.error}</p>}
              {turn.status !== 'running' && <p className="muted small">{turn.status === 'aborted' ? '已停止' : turn.status === 'error' ? '已中断' : '本轮完成'}
                {turn.costUsd !== undefined && ` · $${turn.costUsd.toFixed(4)}`}</p>}
            </div>
          </article>)}
          {snapshot.permissions.map((card) => <section className="permission-card" key={card.permissionId} aria-label="权限确认">
            <div className="message-label"><Icon name="shield" size={17} />需要你的授权<span className="permission-tool">{card.request.toolName}</span></div>
            <h3>{card.request.title}</h3>
            {card.request.preview && <pre>{card.request.preview}</pre>}
            <div className="permission-actions">
              <button className="primary" disabled={!!pending || snapshot.phase !== 'running'}
                onClick={() => void run(card.permissionId, () => window.dcode.respondPermission(card.permissionId, 'allow_once'))}>允许一次</button>
              <button disabled={!!pending || snapshot.phase !== 'running'}
                onClick={() => void run(card.permissionId, () => window.dcode.respondPermission(card.permissionId, 'deny'))}>拒绝</button>
            </div>
          </section>)}
          </div>
        </section>
        <div className="scroll-control">{showLatest && <button className="jump-latest" onClick={latestMessage}><Icon name="down" size={15} />最新消息</button>}</div>

        <form className="composer" onSubmit={(event) => void send(event)}>
          <label className="sr-only" htmlFor="prompt">给 DCODE 的消息</label>
          <div className={`composer-box ${working ? 'is-working' : ''}`}>
          <textarea ref={prompt} id="prompt" value={draft} maxLength={32_000} rows={2} disabled={pending === 'send'}
            placeholder={snapshot.cwd ? '描述你想完成的任务…' : '请先选择项目文件夹'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
                && (preferences.sendKey === 'enter' || event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void send()
              }
            }} />
          <div className="composer-actions"><button type="button" className="model-trigger" onClick={modelSettings}><Icon name="bolt" size={14} /><span>{snapshot.model ?? configuration?.model ?? '配置模型'}</span><Icon name="chevron" size={12} /></button><span className="composer-hint">{preferences.sendKey === 'enter' ? 'Enter' : 'Ctrl / ⌘ + Enter'} 发送</span>
            {working ? <button type="button" className="stop-button" aria-label="停止回合" title="停止回合 Esc" disabled={!!pending || snapshot.phase === 'cancelling'}
              onClick={() => void run('cancel', () => window.dcode.cancelTurn())}><Icon name={snapshot.phase === 'cancelling' ? 'refresh' : 'stop'} size={17} className={snapshot.phase === 'cancelling' ? 'spin' : ''} /></button>
              : <button type="submit" className="primary send-button" aria-label="发送消息" title={!snapshot.cwd ? '请先打开项目' : !snapshot.hasApiKey ? '请先配置模型连接' : '发送消息'} disabled={!canSend}><Icon name="arrow" size={19} /></button>}
          </div></div><div className="composer-footnote"><span><Icon name="shield" size={12} />文件写入与命令执行需授权</span><span>Shift+Enter 换行</span></div>
        </form>
        </div>
        </div>
        <footer className="statusbar"><span><i className={`connection-dot ${snapshot.phase}`} />{PHASE_LABELS[snapshot.phase]}</span><span><Icon name="shield" size={12} />{snapshot.permissionMode === 'default' ? '逐次审批' : '等待握手'}</span><button onClick={() => navigate('usage')}><Icon name="usage" size={13} />用量</button></footer>
      </main>
    </div>
  )
}
