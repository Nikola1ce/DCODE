// DCODE 侧边栏对话面板 —— WebView 前端逻辑（无构建步骤，运行于 webview 沙箱）。
// 职责：
//   - 与扩展宿主通过 postMessage 双向通信（接收服务端事件、发送用户操作）；
//   - 渲染对话流：用户消息、助手流式正文、思维链、工具调用卡片、权限请求卡片、用量注脚；
//   - 处理输入（Enter 发送 / Shift+Enter 换行）、停止、清空、设置、右键选区注入。
// 安全：内置极简且转义安全的 Markdown 渲染（先整体 HTML 转义，再做有限的语法替换），
//       配合严格 CSP，避免 XSS。
// 制作人：Moriarty_Dox

(function () {
  'use strict'

  // 获取与扩展通信的句柄（VS Code webview API）。
  const vscode = acquireVsCodeApi()

  // —— DOM 引用 —— //
  const messagesEl = document.getElementById('messages')
  const inputEl = document.getElementById('input')
  const sendBtn = document.getElementById('btn-send')
  const stopBtn = document.getElementById('btn-stop')
  const clearBtn = document.getElementById('btn-clear')
  const settingsBtn = document.getElementById('btn-settings')
  // 状态栏可点击「药丸」：供应商 / 模型 / 权限模式（点击弹出选择器，类 Cursor）。
  const providerPill = document.getElementById('status-provider')
  const providerLabel = document.getElementById('status-provider-label')
  const statusModel = document.getElementById('status-model')
  const modelLabel = document.getElementById('status-model-label')
  const statusMode = document.getElementById('status-mode')
  const modeLabel = document.getElementById('status-mode-label')
  // 通用下拉选择面板（模型/供应商/权限模式共用）。
  const pickerEl = document.getElementById('picker')
  const pickerHeaderEl = document.getElementById('picker-header')
  const pickerListEl = document.getElementById('picker-list')
  const hintEl = document.getElementById('hint')
  const attachmentsEl = document.getElementById('attachments')
  const commandMenuEl = document.getElementById('command-menu')
  const appEl = document.getElementById('app')
  // 「+ 文件」按钮：点击弹出 VS Code 原生文件选择器（仅选文件，文件可正常显示与多选）。
  const addFileBtn = document.getElementById('btn-add-file')
  // 「+ 文件夹」按钮：点击弹出 VS Code 原生文件夹选择器（与文件分开，规避 Windows 上
  // 「同时选文件和文件夹」会导致文件不可见的限制）。
  const addFolderBtn = document.getElementById('btn-add-folder')

  // —— 运行期状态 —— //
  // 当前进行中的轮次 id（用于停止与把流式增量归并到正确的消息块）。
  let activeRequestId = null
  // 当前轮次的助手消息 DOM 上下文：{ requestId, bodyEl, rawText, reasoningEl, reasoningText, toolEls: Map }
  let currentTurn = null
  // 当前待发送的上下文附件列表（通过「+ 文件/+ 文件夹」按钮或资源管理器右键加入，发送后清空）。
  // 每项形如 { kind:'file'|'selection', path, startLine?, endLine?, snippet?, languageId? }
  let pendingAttachments = []
  // 命令补全状态。
  let commandState = {
    open: false, // 菜单是否展开
    items: [], // 当前候选 [{name,description,completion,aliases}]
    activeIndex: 0, // 高亮项索引
    queryId: null, // 最近一次补全请求 id（用于丢弃过期响应）
    kernelAnswered: false, // 本次查询是否已收到内核候选（用于兜底/内核优先级协调）
  }
  // 权限模式中文名映射。
  const MODE_LABELS = {
    default: '逐次确认',
    acceptEdits: '自动编辑',
    plan: '只读规划',
    bypass: '跳过确认',
  }
  // 权限模式的下拉选项（顺序与终端一致；带一句话说明）。
  const MODE_OPTIONS = [
    { value: 'default', label: '逐次确认', hint: '写文件/执行命令前逐次弹窗确认' },
    { value: 'acceptEdits', label: '自动编辑', hint: '自动放行文件读写，命令仍确认（推荐）' },
    { value: 'plan', label: '只读规划', hint: '禁止任何写入/执行，仅规划' },
    { value: 'bypass', label: '跳过确认', hint: '跳过所有确认（危险，仅完全信任时）' },
  ]

  // 斜杠命令「内置兜底列表」（与内核 src/commands/index.ts 的命令保持同步）。
  // 用途：用户键入 / 时立即在前端渲染候选，无需等待内核往返；当内核在线并返回更丰富的
  // command_suggestions（含按当前模型/Provider 动态生成的子选项）时再覆盖此兜底。
  // 这样即便内核尚未启动/正在启动，命令菜单也能即时出现（方向键 + Enter 选择），体验对齐终端。
  const FALLBACK_COMMANDS = [
    { name: 'help', description: '显示所有可用命令与简要用法', aliases: ['?', 'h'] },
    { name: 'about', description: '关于 DCODE（版本与制作人信息）' },
    { name: 'model', description: '查看或切换模型；/model context 设置上下文长度' },
    { name: 'provider', description: '查看或切换 LLM Provider（zhipu / deepseek / openai）', aliases: ['providers'] },
    { name: 'proxy', description: '查看或设置 HTTP(S) 代理' },
    { name: 'cost', description: '显示本次会话的 token 用量与预估成本' },
    { name: 'clear', description: '清空当前对话历史，开始新话题', aliases: ['new'] },
    { name: 'compact', description: '立即压缩上下文，释放空间但保留关键信息' },
    { name: 'init', description: '分析当前项目并生成/更新 DCODE.md 记忆文件' },
    { name: 'login', description: '设置或更新当前 Provider 的 API Key', aliases: ['key'] },
    { name: 'resume', description: '从历史会话列表中恢复一个会话' },
    { name: 'theme', description: '切换界面主题（暗色/亮色）' },
    { name: 'thinking', description: '开关思维链(reasoning_content)的展示' },
    { name: 'effort', description: '切换推理强度：low | medium | high | max', aliases: ['reasoning-effort'] },
    { name: 'thinking-budget', description: '查看或设置思维链 token 预算', aliases: ['budget'] },
    { name: 'mcp', description: '查看或管理 MCP Server（list / resources / reload）' },
    { name: 'subagents', description: '查看子代理（Task 工具）运行状态与历史', aliases: ['agents'] },
    { name: 'shells', description: '查看后台 Shell 运行状态', aliases: ['bg'] },
    { name: 'hooks', description: '查看或重载 Hooks 钩子（reload）' },
    { name: 'skills', description: '查看可用技能包列表' },
    { name: 'skill', description: '管理技能包：<名称> 加载 / unload / create' },
    { name: 'checkpoints', description: '查看文件检查点列表', aliases: ['cp-list'] },
    { name: 'undo', description: '回退最近 N 个文件检查点（默认 1）' },
    { name: 'commit', description: '根据 staged 变更生成提交信息并提交（需确认）' },
    { name: 'pr', description: '生成 PR 标题与描述（/pr create 尝试 gh pr create）' },
    { name: 'review', description: '代码审查：工作区/暂存/分支差异或指定文件', aliases: ['cr'] },
    { name: 'add-dir', description: '将额外目录加入工作上下文', aliases: ['adddir'] },
    { name: 'mode', description: '查看或切换权限模式：plan | auto | bypass' },
    { name: 'plan', description: '快捷进入「规划模式」（只读）' },
    { name: 'auto', description: '快捷进入「自动接受编辑」模式' },
    { name: 'bypass', description: '快捷进入「跳过确认」模式（危险）' },
    { name: 'memory', description: '显示当前加载的记忆文件路径' },
    { name: 'config', description: '显示当前配置（隐藏密钥）' },
    { name: 'update', description: '检测并更新 DCODE', aliases: ['upgrade'] },
  ]

  // 状态栏当前值与可选项（由 ready/status 下发，供选择器渲染与打勾）。
  let statusState = {
    provider: '', // 当前供应商 id
    model: '', // 当前模型 id
    mode: '', // 当前权限模式
    providers: [], // [{id,name,description,active,hasApiKey}]
    models: [], // [{value,label,hint,active}]
  }
  // 当前打开的选择器类型：'model' | 'provider' | 'mode' | null。
  let openPicker = null

  // 启动时展示空状态。
  renderEmptyState()
  // 初始化「+ 文件 / + 文件夹」选择器入口（拖放已移除，统一用按钮/右键加入上下文）。
  initFilePickers()
  // 初始化状态栏药丸的点击（弹出对应选择器）。
  initStatusPills()

  // —— 输入交互 —— //
  inputEl.addEventListener('keydown', (e) => {
    // 命令补全菜单展开时，方向键/Tab/Enter/Esc 优先用于菜单导航。
    if (commandState.open && commandState.items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveCommandSelection(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveCommandSelection(-1)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        completeActiveCommand()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeCommandMenu()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        // Enter：若高亮项是「可继续输入参数」的命令则补全，否则直接执行。
        e.preventDefault()
        const item = commandState.items[commandState.activeIndex]
        // 命令名补全后通常还需参数，这里统一执行当前输入：
        // 若输入恰为某完整命令则执行，否则先补全。
        if (item && item.completion !== inputEl.value.trim()) {
          completeActiveCommand()
        } else {
          submit()
        }
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  })
  // 输入内容变化：维护命令补全菜单（仅在以 / 开头时）。
  inputEl.addEventListener('input', () => {
    refreshCommandMenu()
  })
  sendBtn.addEventListener('click', submit)
  stopBtn.addEventListener('click', () => {
    if (activeRequestId) vscode.postMessage({ type: 'cancel', requestId: activeRequestId })
  })
  clearBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'clear' })
  })
  settingsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'open_settings' })
  })

  // 代码块操作按钮（复制 / 预览 diff / 应用）：用事件委托处理，兼容流式重渲染重建 DOM。
  messagesEl.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.code-btn') : null
    if (!btn) return
    const block = btn.closest('.code-block')
    if (!block) return
    const code = decodeBase64(block.getAttribute('data-code') || '')
    const languageId = block.getAttribute('data-lang') || ''
    const act = btn.getAttribute('data-act')
    if (act === 'copy') {
      // 复制到剪贴板：优先用 navigator.clipboard，失败则回退让扩展宿主复制。
      copyToClipboard(code, btn)
    } else if (act === 'diff') {
      vscode.postMessage({ type: 'preview_diff', code, languageId })
    } else if (act === 'apply') {
      vscode.postMessage({ type: 'apply_code', code, languageId })
    }
  })

  /**
   * 复制文本到剪贴板，并给按钮短暂的「已复制」反馈。
   * @param {string} text 要复制的文本。
   * @param {HTMLElement} btn 触发的按钮（用于反馈）。
   */
  function copyToClipboard(text, btn) {
    const flash = () => {
      const old = btn.textContent
      btn.textContent = '已复制'
      setTimeout(() => {
        btn.textContent = old
      }, 1200)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, () => {
        vscode.postMessage({ type: 'copy_code', code: text })
        flash()
      })
    } else {
      // WebView 沙箱可能禁用 clipboard API，交给扩展宿主用 env.clipboard 复制。
      vscode.postMessage({ type: 'copy_code', code: text })
      flash()
    }
  }

  /**
   * 提交输入框内容：斜杠命令走命令通道，普通文本（可带附件）走对话通道。
   */
  function submit() {
    const text = inputEl.value.trim()
    if (activeRequestId) return // 进行中时禁止并发提交。

    // 斜杠命令：交给后台内核复用 CLI 命令系统执行。
    if (text.startsWith('/')) {
      closeCommandMenu()
      vscode.postMessage({ type: 'slash_command', input: text })
      inputEl.value = ''
      return
    }

    // 普通对话：允许「仅附件无文本」的发送。
    if (!text && pendingAttachments.length === 0) return
    const attachments = pendingAttachments.slice()
    vscode.postMessage({ type: 'send', text, attachments })
    inputEl.value = ''
    clearAttachments()
  }

  // —— 上下文附件（chips） —— //

  /**
   * 生成附件的展示标签：文件显示路径，选区附带行号范围。
   * @param {object} a 附件对象。
   * @returns {string} 标签文本。
   */
  function formatAttachmentLabel(a) {
    if (!a) return ''
    if (a.kind === 'selection') {
      const range = a.startLine && a.endLine ? ' :' + a.startLine + '-' + a.endLine : ''
      return a.path + range
    }
    return a.path
  }

  /**
   * 处理扩展宿主回填的附件（来自「+ 文件/+ 文件夹」选择器或右键「加入对话」）。
   * @param {Array} atts 附件数组。
   */
  function onAttachmentsAdded(atts) {
    if (!Array.isArray(atts)) return
    for (const a of atts) {
      if (!a || !a.path) continue
      // 去重：同 kind + path（+ 选区行号）视为同一附件。
      const key = a.kind + '|' + a.path + '|' + (a.startLine || '') + '|' + (a.endLine || '')
      if (pendingAttachments.some((x) => (x.kind + '|' + x.path + '|' + (x.startLine || '') + '|' + (x.endLine || '')) === key)) {
        continue
      }
      pendingAttachments.push(a)
    }
    renderAttachments()
    inputEl.focus()
  }

  /** 渲染待发送附件 chips 区。 */
  function renderAttachments() {
    if (pendingAttachments.length === 0) {
      attachmentsEl.classList.add('hidden')
      attachmentsEl.innerHTML = ''
      return
    }
    attachmentsEl.classList.remove('hidden')
    attachmentsEl.innerHTML = ''
    pendingAttachments.forEach((a, i) => {
      const chip = document.createElement('span')
      chip.className = 'ctx-chip'
      const label = document.createElement('span')
      label.className = 'ctx-chip-label'
      label.textContent = formatAttachmentLabel(a)
      const close = document.createElement('button')
      close.className = 'ctx-chip-remove'
      close.title = '移除'
      close.textContent = '×'
      close.addEventListener('click', () => removeAttachment(i))
      chip.appendChild(label)
      chip.appendChild(close)
      attachmentsEl.appendChild(chip)
    })
  }

  /**
   * 移除指定下标的附件。
   * @param {number} index 下标。
   */
  function removeAttachment(index) {
    pendingAttachments.splice(index, 1)
    renderAttachments()
  }

  /** 清空全部待发送附件。 */
  function clearAttachments() {
    pendingAttachments = []
    renderAttachments()
  }

  // —— 加入上下文：文件/文件夹选择器入口 —— //
  // 说明：早期版本支持「把文件从资源管理器拖入面板」，但 VS Code Webview 出于安全会清洗
  // 拖放数据，导致在多数平台上拿不到文件 URI、拖放不可靠。现已彻底移除拖放交互与遮罩，
  // 统一改用 100% 可靠、可发现的入口：下方「+ 文件 / + 文件夹」按钮，或资源管理器右键
  // 「DCODE: 将文件加入对话」。

  /**
   * 绑定「+ 文件 / + 文件夹」按钮：点击后请求扩展宿主弹出 VS Code 原生选择器。
   * 原生选择器在宿主侧直接拿到真实 URI，规避 Webview 拖放被沙箱清洗的限制。
   */
  function initFilePickers() {
    // 「+ 文件」按钮：弹出 VS Code 原生文件选择器（仅选文件）。
    if (addFileBtn) {
      addFileBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'browse_files', mode: 'file' })
      })
    }
    // 「+ 文件夹」按钮：弹出 VS Code 原生文件夹选择器（仅选文件夹）。
    if (addFolderBtn) {
      addFolderBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'browse_files', mode: 'folder' })
      })
    }
  }

  // —— 斜杠命令补全菜单 —— //

  /**
   * 根据当前输入刷新命令补全菜单：以 / 开头时立即渲染「内置兜底候选」，
   * 同时向内核请求更丰富的候选（内核在线时返回后会覆盖兜底）。
   * 这样无论内核是否就绪，输入 / 都能即时出现可用方向键/Enter 选择的菜单。
   */
  function refreshCommandMenu() {
    const val = inputEl.value
    if (!val.startsWith('/')) {
      closeCommandMenu()
      return
    }
    // 生成一次性 queryId（内核响应据此丢弃过期项）。
    const queryId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    commandState.queryId = queryId
    // 本次查询尚未收到内核候选：先用兜底列表即时呈现。
    commandState.kernelAnswered = false
    const fallback = buildFallbackSuggestions(val)
    if (fallback.length > 0) {
      // 保留当前高亮位置（在合理范围内），避免每次输入都跳回第一项。
      commandState.items = fallback
      if (commandState.activeIndex >= fallback.length) commandState.activeIndex = 0
      commandState.open = true
      renderCommandMenu()
    } else {
      // 兜底也没有匹配（如 /xyz）：先关菜单，等内核可能的响应。
      closeCommandMenu()
    }
    // 仍请求内核候选（在线时会带来模型列表、MCP、子选项等更准确的结果）。
    vscode.postMessage({ type: 'request_commands', queryId, input: val })
  }

  /**
   * 基于内置 FALLBACK_COMMANDS 生成与当前输入匹配的补全候选。
   * 规则：
   *   - 仅输入「/」或「/前缀」时，按命令名/别名前缀过滤，返回命令名级候选；
   *   - 已输入「/cmd 」（命令名后带空格，进入参数阶段）时，兜底不猜参数，返回空（交给内核）。
   * @param {string} val 输入框完整内容（以 / 开头）。
   * @returns {Array} 候选数组 [{name,description,completion,aliases}]。
   */
  function buildFallbackSuggestions(val) {
    const body = val.slice(1) // 去掉前导 /
    // 进入参数阶段（含空格）：兜底不处理参数补全，留给内核。
    if (body.indexOf(' ') >= 0) return []
    const q = body.toLowerCase()
    const out = []
    for (const cmd of FALLBACK_COMMANDS) {
      const names = [cmd.name, ...(cmd.aliases || [])]
      // 空查询返回全部；否则命令名或别名以 q 前缀匹配。
      if (q === '' || names.some((n) => n.toLowerCase().startsWith(q))) {
        out.push({
          name: cmd.name,
          description: cmd.description,
          completion: '/' + cmd.name,
          aliases: cmd.aliases,
        })
      }
    }
    return out
  }

  /**
   * 处理内核回传的命令补全候选：内核在线时其结果更准确（含模型列表、MCP、子选项），
   * 覆盖此前展示的兜底候选；若内核返回空，则保留已展示的兜底（不闪关菜单）。
   * @param {object} msg command_suggestions 消息。
   */
  function onCommandSuggestions(msg) {
    // 丢弃过期响应（用户已继续输入，queryId 已变）。
    if (!msg || msg.queryId !== commandState.queryId) return
    // 输入框已不是 / 开头则不展示。
    if (!inputEl.value.startsWith('/')) {
      closeCommandMenu()
      return
    }
    commandState.kernelAnswered = true
    const suggestions = Array.isArray(msg.suggestions) ? msg.suggestions : []
    if (suggestions.length === 0) {
      // 内核无候选：若当前已用兜底打开着菜单则保留，否则关闭。
      if (!commandState.open || commandState.items.length === 0) closeCommandMenu()
      return
    }
    // 用内核候选覆盖；尽量保留当前高亮项（按 completion 匹配），否则回到首项。
    const prevActive = commandState.items[commandState.activeIndex]
    commandState.items = suggestions
    const keepIdx = prevActive
      ? suggestions.findIndex((s) => s.completion === prevActive.completion)
      : -1
    commandState.activeIndex = keepIdx >= 0 ? keepIdx : 0
    commandState.open = true
    renderCommandMenu()
  }

  /** 渲染命令补全菜单。 */
  function renderCommandMenu() {
    commandMenuEl.innerHTML = ''
    commandState.items.forEach((item, i) => {
      const row = document.createElement('div')
      row.className = 'command-item' + (i === commandState.activeIndex ? ' active' : '')
      const name = document.createElement('span')
      name.className = 'command-item-name'
      name.textContent = item.completion || ('/' + item.name)
      const desc = document.createElement('span')
      desc.className = 'command-item-desc'
      desc.textContent = item.description || ''
      row.appendChild(name)
      row.appendChild(desc)
      // 鼠标悬停高亮 + 点击补全。
      row.addEventListener('mouseenter', () => {
        commandState.activeIndex = i
        updateCommandActiveClass()
      })
      row.addEventListener('mousedown', (e) => {
        // mousedown 而非 click：避免 textarea 先失焦导致补全后光标丢失。
        e.preventDefault()
        commandState.activeIndex = i
        completeActiveCommand()
      })
      commandMenuEl.appendChild(row)
    })
    commandMenuEl.classList.remove('hidden')
  }

  /** 仅更新高亮项的样式类（不重建 DOM）。 */
  function updateCommandActiveClass() {
    const rows = commandMenuEl.querySelectorAll('.command-item')
    rows.forEach((r, i) => {
      r.classList.toggle('active', i === commandState.activeIndex)
    })
  }

  /**
   * 移动命令菜单高亮项。
   * @param {number} delta +1 下移 / -1 上移。
   */
  function moveCommandSelection(delta) {
    const n = commandState.items.length
    if (n === 0) return
    commandState.activeIndex = (commandState.activeIndex + delta + n) % n
    updateCommandActiveClass()
    // 让高亮项滚动进可视区。
    const active = commandMenuEl.querySelectorAll('.command-item')[commandState.activeIndex]
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' })
  }

  /** 用当前高亮项补全输入框（命令名后补一个空格以便继续输入参数）。 */
  function completeActiveCommand() {
    const item = commandState.items[commandState.activeIndex]
    if (!item) return
    const completion = item.completion || ('/' + item.name)
    inputEl.value = completion + ' '
    inputEl.focus()
    // 补全后立即再请求一次（可能进入参数补全阶段，如 /model 后的模型列表）。
    refreshCommandMenu()
  }

  /** 关闭命令补全菜单。 */
  function closeCommandMenu() {
    commandState.open = false
    commandState.items = []
    commandState.activeIndex = 0
    commandState.kernelAnswered = false
    commandMenuEl.classList.add('hidden')
    commandMenuEl.innerHTML = ''
  }

  /**
   * 处理本地斜杠命令的执行结果。
   * @param {object} msg command_result 消息。
   */
  function onCommandResult(msg) {
    if (msg.cleared) {
      // 命令清空了上下文：清屏并复位。
      messagesEl.innerHTML = ''
      currentTurn = null
      activeRequestId = null
      setBusy(false)
      if (msg.message) showSystemLine('info', msg.message)
      else renderEmptyState()
      return
    }
    if (msg.submitted) {
      // 命令已转为一轮后台任务：先展示提示语，并进入处理中态等待流式事件。
      if (msg.message) showSystemLine('info', msg.message)
      beginAssistantTurn(msg.requestId)
      setBusy(true, msg.requestId)
      return
    }
    // 普通命令结果：作为系统行展示（hint 用更柔和的提示色）。
    if (msg.message) {
      showSystemLine(msg.hint ? 'warn' : 'info', msg.message)
    }
  }

  // —— 面板内 /login：API Key 录入弹窗 —— //

  // 当前打开的登录弹窗 DOM（同一时刻仅一个，避免重复叠加）。
  let loginModalEl = null

  /**
   * 展示「API Key 录入」安全弹窗（响应内核 login_prompt）。
   * 提供掩码输入框 + 平台链接/端点/环境变量提示 + 保存/取消；Enter 提交、Esc 取消。
   * 提交后通过 submit_api_key 把 Key 交给内核保存并热更新；UI 仅做必要校验，不在前端持久化。
   * @param {object} msg login_prompt 消息（providerId/providerName/platformUrl/baseURL/apiKeyEnv）。
   */
  function showLoginPrompt(msg) {
    // 已有弹窗：先关闭旧的，确保 provider 信息为最新。
    closeLoginPrompt()
    const providerId = msg.providerId || ''
    const providerName = msg.providerName || '当前供应商'
    const platformUrl = msg.platformUrl || ''
    const baseURL = msg.baseURL || ''
    const apiKeyEnv = msg.apiKeyEnv || ''

    // 遮罩 + 卡片容器。
    const overlay = document.createElement('div')
    overlay.className = 'login-overlay'

    const card = document.createElement('div')
    card.className = 'login-card'

    // 标题。
    const title = document.createElement('div')
    title.className = 'login-title'
    title.textContent = '设置 ' + providerName + ' API Key'
    card.appendChild(title)

    // 说明区：平台链接（可点击）、端点、环境变量、存储位置。
    const meta = document.createElement('div')
    meta.className = 'login-meta'
    if (platformUrl) {
      const p = document.createElement('div')
      p.appendChild(document.createTextNode('获取 Key：'))
      const a = document.createElement('a')
      a.href = platformUrl
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = platformUrl
      p.appendChild(a)
      meta.appendChild(p)
    }
    if (baseURL) {
      const b = document.createElement('div')
      b.textContent = '端点：' + baseURL
      meta.appendChild(b)
    }
    if (apiKeyEnv) {
      const e = document.createElement('div')
      e.textContent = '也可设置环境变量 ' + apiKeyEnv + '（设置后需重启内核）。'
      meta.appendChild(e)
    }
    const store = document.createElement('div')
    store.textContent = '密钥保存在 ~/.dcode/config.json（providers.' + providerId + '，各供应商独立）。'
    meta.appendChild(store)
    card.appendChild(meta)

    // 输入框（密码类型掩码显示，避免肩窥）。
    const inputRow = document.createElement('div')
    inputRow.className = 'login-input-row'
    const keyInput = document.createElement('input')
    keyInput.type = 'password'
    keyInput.className = 'login-input'
    keyInput.placeholder = '在此粘贴 ' + providerName + ' API Key'
    keyInput.autocomplete = 'off'
    keyInput.spellcheck = false
    inputRow.appendChild(keyInput)
    card.appendChild(inputRow)

    // 操作按钮。
    const actions = document.createElement('div')
    actions.className = 'login-actions'
    const saveBtn = document.createElement('button')
    saveBtn.className = 'login-save'
    saveBtn.textContent = '保存'
    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'login-cancel'
    cancelBtn.textContent = '取消'
    actions.appendChild(saveBtn)
    actions.appendChild(cancelBtn)
    card.appendChild(actions)

    /** 提交当前输入的 Key（非空才提交并关闭）。 */
    const submitKey = () => {
      const v = keyInput.value.trim()
      if (!v) {
        keyInput.focus()
        return
      }
      vscode.postMessage({ type: 'submit_api_key', provider: providerId, apiKey: v })
      closeLoginPrompt()
    }

    saveBtn.addEventListener('click', submitKey)
    cancelBtn.addEventListener('click', () => {
      closeLoginPrompt()
      showSystemLine('info', '已取消 API Key 设置。')
    })
    // Enter 提交、Esc 取消（捕获在输入框上，避免触发全局 Esc）。
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submitKey()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closeLoginPrompt()
        showSystemLine('info', '已取消 API Key 设置。')
      }
    })

    overlay.appendChild(card)
    appEl.appendChild(overlay)
    loginModalEl = overlay
    // 自动聚焦输入框，便于直接粘贴。
    keyInput.focus()
  }

  /** 关闭并移除当前的 API Key 录入弹窗（若有）。 */
  function closeLoginPrompt() {
    if (loginModalEl && loginModalEl.parentNode) {
      loginModalEl.parentNode.removeChild(loginModalEl)
    }
    loginModalEl = null
  }

  // —— 接收扩展宿主消息 —— //
  window.addEventListener('message', (event) => {
    const msg = event.data
    if (!msg || typeof msg.type !== 'string') return
    handleMessage(msg)
  })

  /**
   * 分发并处理来自扩展宿主的一条消息。
   * @param {any} msg 含 type 的消息对象。
   */
  function handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        onReady(msg)
        break
      case 'status':
        updateStatus(msg)
        break
      case 'user_message':
        clearEmptyState()
        appendUserMessage(msg.text, msg.attachments)
        // 斜杠命令回显（isCommand）不在此进入「处理中」态：纯本地命令（/login、/help、/model
        // 等）只会回一条 command_result 而永远没有 turn_done，若此处就 setBusy(true) 会导致发送键
        // 卡在「停止」且点击无效。是否开始助手轮次/进入忙碌，交由 onCommandResult 在
        // submitted=true（命令转后台 prompt，如 /init、/commit）时再处理。
        if (!msg.isCommand) {
          beginAssistantTurn(msg.requestId)
          setBusy(true, msg.requestId)
        }
        break
      case 'command_suggestions':
        onCommandSuggestions(msg)
        break
      case 'command_result':
        onCommandResult(msg)
        break
      case 'login_prompt':
        showLoginPrompt(msg)
        break
      case 'attachments_added':
        onAttachmentsAdded(msg.attachments)
        break
      case 'reasoning':
        appendReasoning(msg.requestId, msg.delta)
        break
      case 'text':
        appendText(msg.requestId, msg.delta)
        break
      case 'tool_start':
        addToolCard(msg)
        break
      case 'tool_progress':
        updateToolProgress(msg)
        break
      case 'tool_end':
        finishToolCard(msg)
        break
      case 'permission_request':
        addPermissionCard(msg)
        break
      case 'turn_done':
        finishTurn(msg)
        break
      case 'turn_error':
        showSystemLine('error', msg.message || '出错了。')
        finishTurn({ requestId: msg.requestId, reason: 'error' })
        break
      case 'cleared':
        messagesEl.innerHTML = ''
        currentTurn = null
        activeRequestId = null
        setBusy(false)
        renderEmptyState()
        break
      case 'kernel_starting':
        // 用「可替换的瞬时状态行」展示启动中提示，待 ready/error/exit 到达后清除，
        // 避免像旧实现那样把「正在启动后台内核…」作为永久文字残留在界面（误以为一直卡在启动中）。
        showKernelStatus('正在启动后台内核…')
        break
      case 'kernel_error':
        // 启动失败：先清掉「正在启动…」状态行，再以错误行展示原因。
        clearKernelStatus()
        showSystemLine('error', '内核启动失败：' + (msg.message || ''))
        break
      case 'kernel_exit':
        // 内核退出：清掉可能残留的启动状态行，提示可重启或重新发送拉起。
        clearKernelStatus()
        showSystemLine('warn', '后台内核已退出' + (msg.code != null ? '（code=' + msg.code + '）' : '') + '。可点击“设置”旁的重启，或重新发送消息以拉起。')
        setBusy(false)
        break
      case 'log':
        if (msg.level === 'error' || msg.level === 'warn') {
          showSystemLine(msg.level, msg.message)
        }
        break
      case 'inject_selection':
        onInjectSelection(msg)
        break
      default:
        break
    }
  }

  /**
   * 处理 ready：更新状态栏（含供应商/模型/模式与可选列表）、按需提示缺少 API Key。
   * @param {any} msg ready 消息。
   */
  function onReady(msg) {
    // 内核已就绪：清除「正在启动后台内核…」瞬时状态行（启动成功，无需再提示）。
    clearKernelStatus()
    updateStatus(msg)
    if (!msg.hasApiKey) {
      showSystemLine(
        'warn',
        '尚未配置可用的 API Key。在下方输入框输入 /login 并回车，即可在面板内直接录入；也可设置相应环境变量后点击重启。',
      )
    }
  }

  /**
   * 更新顶部状态栏：供应商、模型、权限模式，以及可切换的供应商/模型列表。
   * 同步刷新已打开的选择器（如切换后菜单仍开着）。
   * @param {object} msg ready 或 status 消息（含 provider/model/permissionMode/providers/models）。
   */
  function updateStatus(msg) {
    if (!msg) return
    if (typeof msg.provider === 'string') statusState.provider = msg.provider
    if (typeof msg.model === 'string') statusState.model = msg.model
    if (typeof msg.permissionMode === 'string') statusState.mode = msg.permissionMode
    if (Array.isArray(msg.providers)) statusState.providers = msg.providers
    if (Array.isArray(msg.models)) statusState.models = msg.models

    // 供应商药丸：优先显示供应商展示名（从列表里查 active 项），回退到 id。
    const activeProvider =
      statusState.providers.find((p) => p.id === statusState.provider) ||
      statusState.providers.find((p) => p.active)
    providerLabel.textContent = activeProvider
      ? activeProvider.name
      : statusState.provider || 'DCODE'

    // 模型药丸：优先显示模型 label（从列表里查），回退到 model id。
    const activeModel =
      statusState.models.find((m) => m.value === statusState.model) ||
      statusState.models.find((m) => m.active)
    modelLabel.textContent = activeModel
      ? activeModel.label
      : statusState.model || '模型'
    statusModel.title = '点击切换模型' + (statusState.model ? '（当前：' + statusState.model + '）' : '')

    // 权限模式药丸。
    modeLabel.textContent = MODE_LABELS[statusState.mode] || statusState.mode || ''

    // 若选择器正开着，刷新其内容以反映新状态（打勾位置等）。
    if (openPicker) renderPicker(openPicker)
  }

  // —— 状态栏药丸 + 通用选择器（类 Cursor 的点击切换） —— //

  /**
   * 绑定三个状态栏药丸的点击：分别打开「模型 / 供应商 / 权限模式」选择器。
   * 同时绑定全局点击/Esc 以关闭选择器。
   */
  function initStatusPills() {
    providerPill.addEventListener('click', (e) => {
      e.stopPropagation()
      togglePicker('provider', providerPill)
    })
    statusModel.addEventListener('click', (e) => {
      e.stopPropagation()
      togglePicker('model', statusModel)
    })
    statusMode.addEventListener('click', (e) => {
      e.stopPropagation()
      togglePicker('mode', statusMode)
    })
    // 点击选择器以外区域关闭。
    document.addEventListener('click', (e) => {
      if (!openPicker) return
      if (pickerEl.contains(e.target)) return
      closePicker()
    })
    // Esc 关闭。
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && openPicker) {
        closePicker()
      }
    })
  }

  /**
   * 切换某个选择器的开合：已打开同类则关闭，否则打开并定位到触发药丸下方。
   * @param {string} kind 'model' | 'provider' | 'mode'。
   * @param {HTMLElement} anchorEl 触发的药丸元素（用于定位）。
   */
  function togglePicker(kind, anchorEl) {
    if (openPicker === kind) {
      closePicker()
      return
    }
    openPicker = kind
    renderPicker(kind)
    positionPicker(anchorEl)
    pickerEl.classList.remove('hidden')
    setPillExpanded(kind, true)
  }

  /** 关闭选择器并复位药丸状态。 */
  function closePicker() {
    openPicker = null
    pickerEl.classList.add('hidden')
    pickerEl.classList.remove('picker-up')
    setPillExpanded('model', false)
    setPillExpanded('provider', false)
    setPillExpanded('mode', false)
  }

  /**
   * 设置药丸的「展开」视觉态（高亮 + 旋转箭头）。
   * @param {string} kind 选择器类型。
   * @param {boolean} expanded 是否展开。
   */
  function setPillExpanded(kind, expanded) {
    const el = kind === 'model' ? statusModel : kind === 'provider' ? providerPill : statusMode
    if (el) el.classList.toggle('expanded', expanded)
  }

  /**
   * 把选择器定位到触发药丸的正下方（随状态栏左对齐，避免溢出右侧）。
   * @param {HTMLElement} anchorEl 触发药丸。
   */
  function positionPicker(anchorEl) {
    const barRect = appEl.getBoundingClientRect()
    const rect = anchorEl.getBoundingClientRect()
    // 以 #app 为定位参照，left 对齐药丸，top 紧贴状态栏下方。
    let left = rect.left - barRect.left
    const top = rect.bottom - barRect.top + 4
    // 防止右溢出：选择器最大宽度由 CSS 控制，这里夹取 left。
    const maxLeft = barRect.width - 16 - 240
    if (left > maxLeft) left = Math.max(8, maxLeft)
    pickerEl.style.left = left + 'px'
    pickerEl.style.top = top + 'px'
  }

  /**
   * 渲染选择器内容：根据类型取选项、当前值、点击回调。
   * @param {string} kind 'model' | 'provider' | 'mode'。
   */
  function renderPicker(kind) {
    let title = ''
    let options = []
    let currentValue = ''
    /** 选项点击后的处理：发指令切换并关闭菜单。 */
    let onPick = null

    if (kind === 'model') {
      title = '选择模型'
      currentValue = statusState.model
      options = statusState.models.map((m) => ({
        value: m.value,
        label: m.label,
        hint: m.hint || '',
        active: m.value === currentValue || m.active,
        disabled: false,
      }))
      if (options.length === 0) {
        options = [{ value: '', label: '（暂无可选模型）', hint: '', active: false, disabled: true }]
      }
      onPick = (opt) => {
        if (!opt.value || opt.value === statusState.model) return
        vscode.postMessage({ type: 'set_model', model: opt.value })
      }
    } else if (kind === 'provider') {
      title = '选择供应商'
      currentValue = statusState.provider
      options = statusState.providers.map((p) => ({
        value: p.id,
        label: p.name,
        // 无 Key 时附加提示，引导用户去配置。
        hint: (p.description || '') + (p.hasApiKey ? '' : ' · 未配置 Key'),
        active: p.id === currentValue || p.active,
        disabled: false,
      }))
      if (options.length === 0) {
        options = [{ value: '', label: '（暂无可切换供应商）', hint: '', active: false, disabled: true }]
      }
      onPick = (opt) => {
        if (!opt.value || opt.value === statusState.provider) return
        vscode.postMessage({ type: 'set_provider', provider: opt.value })
      }
    } else {
      title = '权限模式'
      currentValue = statusState.mode
      options = MODE_OPTIONS.map((m) => ({
        value: m.value,
        label: m.label,
        hint: m.hint,
        active: m.value === currentValue,
        disabled: false,
      }))
      onPick = (opt) => {
        if (!opt.value || opt.value === statusState.mode) return
        vscode.postMessage({ type: 'set_permission_mode', mode: opt.value })
      }
    }

    pickerHeaderEl.textContent = title
    pickerListEl.innerHTML = ''
    options.forEach((opt) => {
      const row = document.createElement('div')
      row.className = 'picker-item' + (opt.active ? ' active' : '') + (opt.disabled ? ' disabled' : '')
      row.setAttribute('role', 'option')
      if (opt.active) row.setAttribute('aria-selected', 'true')

      const check = document.createElement('span')
      check.className = 'picker-check'
      check.textContent = opt.active ? '✓' : ''

      const main = document.createElement('span')
      main.className = 'picker-main'
      const name = document.createElement('span')
      name.className = 'picker-name'
      name.textContent = opt.label
      main.appendChild(name)
      if (opt.hint) {
        const hint = document.createElement('span')
        hint.className = 'picker-hint'
        hint.textContent = opt.hint
        main.appendChild(hint)
      }

      row.appendChild(check)
      row.appendChild(main)
      if (!opt.disabled) {
        row.addEventListener('click', (e) => {
          e.stopPropagation()
          if (onPick) onPick(opt)
          closePicker()
        })
      }
      pickerListEl.appendChild(row)
    })
  }

  /**
   * 处理右键选区注入：把代码（及可选提问）填入输入框，必要时自动发送。
   * @param {any} msg inject_selection 消息。
   */
  function onInjectSelection(msg) {
    const fence = '```' + (msg.languageId || '') + '\n' + msg.code + '\n```'
    const header = msg.relPath ? '文件：`' + msg.relPath + '`\n\n' : ''
    const body = msg.prompt ? msg.prompt + '\n\n' + header + fence : header + fence
    if (msg.autoSend && msg.prompt) {
      if (activeRequestId) {
        // 有进行中的轮次：先填入输入框，避免打断。
        inputEl.value = body
        inputEl.focus()
        return
      }
      vscode.postMessage({ type: 'send', text: body })
    } else {
      // 仅注入：追加到现有输入后面，方便用户补充问题。
      inputEl.value = inputEl.value ? inputEl.value + '\n\n' + body : body
      inputEl.focus()
    }
  }

  // —— 渲染：消息块 —— //

  /**
   * 渲染空状态提示。
   */
  function renderEmptyState() {
    if (messagesEl.querySelector('#empty-state')) return
    const div = document.createElement('div')
    div.id = 'empty-state'
    div.innerHTML =
      '<h3>DCODE</h3>' +
      '<div>向 DCODE 提问开始对话。</div>' +
      '<div>点击 <strong>+ 文件</strong> / <strong>+ 文件夹</strong> 可将文件加入上下文。</div>' +
      '<div>输入 <strong>/</strong> 使用命令（如 /model、/commit、/review）。</div>' +
      '<div>选中代码后右键可使用「加入上下文 / 解释 / 修复 / 重构」。</div>'
    messagesEl.appendChild(div)
  }

  /** 移除空状态提示。 */
  function clearEmptyState() {
    const el = messagesEl.querySelector('#empty-state')
    if (el) el.remove()
  }

  /**
   * 追加一条用户消息。
   * @param {string} text 用户输入。
   * @param {Array} [attachments] 随消息携带的上下文附件（展示为 chips）。
   */
  function appendUserMessage(text, attachments) {
    const wrap = document.createElement('div')
    wrap.className = 'msg user'
    let html = '<div class="msg-role">你</div>'
    // 附件 chips：在正文上方以只读形式展示本轮带入的文件/选区。
    if (attachments && attachments.length > 0) {
      const chips = attachments
        .map((a) => '<span class="ctx-chip readonly">' + escapeHtml(formatAttachmentLabel(a)) + '</span>')
        .join('')
      html += '<div class="msg-attachments">' + chips + '</div>'
    }
    if (text) {
      html += '<div class="msg-body">' + renderMarkdown(text) + '</div>'
    }
    wrap.innerHTML = html
    messagesEl.appendChild(wrap)
    scrollToBottom()
  }

  /**
   * 开始一个助手轮次：创建空的助手消息块并记录上下文。
   * @param {string} requestId 轮次 id。
   */
  function beginAssistantTurn(requestId) {
    const wrap = document.createElement('div')
    wrap.className = 'msg assistant'
    wrap.innerHTML = '<div class="msg-role">DCODE</div>'
    const body = document.createElement('div')
    body.className = 'msg-body cursor-blink'
    wrap.appendChild(body)
    messagesEl.appendChild(wrap)
    currentTurn = {
      requestId,
      wrapEl: wrap,
      bodyEl: body,
      rawText: '',
      reasoningEl: null,
      reasoningText: '',
      toolEls: new Map(),
    }
    scrollToBottom()
  }

  /**
   * 确保当前轮次上下文存在且匹配 requestId（流式增量可能早于 user_message 到达）。
   * @param {string} requestId 轮次 id。
   * @returns {object|null} 当前轮次上下文。
   */
  function ensureTurn(requestId) {
    if (currentTurn && currentTurn.requestId === requestId) return currentTurn
    // 不匹配则新建（兜底）。
    clearEmptyState()
    beginAssistantTurn(requestId)
    return currentTurn
  }

  /**
   * 追加助手正文增量并增量渲染 Markdown。
   * @param {string} requestId 轮次 id。
   * @param {string} delta 文本增量。
   */
  function appendText(requestId, delta) {
    const turn = ensureTurn(requestId)
    turn.rawText += delta
    turn.bodyEl.innerHTML = renderMarkdown(turn.rawText)
    scrollToBottom()
  }

  /**
   * 追加思维链增量（折叠展示）。
   * @param {string} requestId 轮次 id。
   * @param {string} delta 思维链增量。
   */
  function appendReasoning(requestId, delta) {
    const turn = ensureTurn(requestId)
    if (!turn.reasoningEl) {
      const details = document.createElement('details')
      details.className = 'reasoning'
      details.open = true
      const summary = document.createElement('summary')
      summary.textContent = '思考过程'
      const content = document.createElement('div')
      details.appendChild(summary)
      details.appendChild(content)
      // 思维链插入到正文之前。
      turn.wrapEl.insertBefore(details, turn.bodyEl)
      turn.reasoningEl = content
    }
    turn.reasoningText += delta
    turn.reasoningEl.textContent = turn.reasoningText
    scrollToBottom()
  }

  // —— 渲染：工具卡片 —— //

  /**
   * 新增一个工具调用卡片。
   * @param {any} msg tool_start 消息。
   */
  function addToolCard(msg) {
    const turn = ensureTurn(msg.requestId)
    const card = document.createElement('div')
    card.className = 'tool-card'
    card.innerHTML =
      '<div class="tool-card-head">' +
      '<span class="tool-icon">⚙</span>' +
      '<span class="tool-name"></span>' +
      '<span class="tool-summary"></span>' +
      '<span class="tool-status running">运行中…</span>' +
      '</div>' +
      '<div class="tool-detail hidden"></div>'
    card.querySelector('.tool-name').textContent = msg.name
    card.querySelector('.tool-summary').textContent = msg.summary || ''
    const detail = card.querySelector('.tool-detail')
    const head = card.querySelector('.tool-card-head')
    // 点击标题展开/收起详情。
    head.addEventListener('click', () => {
      detail.classList.toggle('hidden')
    })
    // 工具卡片插入到正文之前（工具通常先于后续正文）。
    turn.wrapEl.insertBefore(card, turn.bodyEl)
    turn.toolEls.set(msg.toolCallId, { card, detail, progress: '' })
    scrollToBottom()
  }

  /**
   * 更新工具卡片的实时进度。
   * @param {any} msg tool_progress 消息。
   */
  function updateToolProgress(msg) {
    const turn = currentTurn
    if (!turn) return
    const entry = turn.toolEls.get(msg.toolCallId)
    if (!entry) return
    entry.progress += msg.text
    entry.detail.classList.remove('hidden')
    entry.detail.textContent = entry.progress
    scrollToBottom()
  }

  /**
   * 完成工具卡片：更新状态与详情。
   * @param {any} msg tool_end 消息。
   */
  function finishToolCard(msg) {
    const turn = currentTurn
    if (!turn) return
    const entry = turn.toolEls.get(msg.toolCallId)
    if (!entry) return
    const status = entry.card.querySelector('.tool-status')
    if (msg.isError) {
      status.className = 'tool-status err'
      status.textContent = '失败'
    } else {
      status.className = 'tool-status ok'
      status.textContent = msg.summary || '完成'
    }
    // 详情优先展示完整结果（detail），其次保留进度。
    const detailText = msg.detail || entry.progress
    if (detailText) {
      entry.detail.textContent = detailText
    }
    scrollToBottom()
  }

  // —— 渲染：权限请求 —— //

  /**
   * 新增权限请求卡片，等待用户决策。
   * @param {any} msg permission_request 消息。
   */
  function addPermissionCard(msg) {
    const turn = ensureTurn(msg.requestId)
    const req = msg.request || {}
    const card = document.createElement('div')
    card.className = 'perm-card'
    const previewHtml = req.preview
      ? '<div class="perm-preview"></div>'
      : ''
    card.innerHTML =
      '<div class="perm-title">需要授权：' +
      escapeHtml(req.title || req.toolName || '操作') +
      '</div>' +
      previewHtml +
      '<div class="perm-actions">' +
      '<button class="btn-allow">允许一次</button>' +
      '<button class="btn-always">总是允许</button>' +
      '<button class="btn-deny">拒绝</button>' +
      '</div>'
    if (req.preview) {
      card.querySelector('.perm-preview').textContent = req.preview
    }
    const actions = card.querySelector('.perm-actions')
    /**
     * 提交权限决策并禁用按钮。
     * @param {string} decision 决策值。
     * @param {string} label 决策中文标签。
     */
    const decide = (decision, label) => {
      vscode.postMessage({
        type: 'permission_decision',
        permissionId: msg.permissionId,
        decision,
      })
      actions.remove()
      const resolved = document.createElement('div')
      resolved.className = 'perm-resolved'
      resolved.textContent = '已' + label
      card.appendChild(resolved)
    }
    card.querySelector('.btn-allow').addEventListener('click', () => decide('allow_once', '允许'))
    card.querySelector('.btn-always').addEventListener('click', () => decide('allow_always', '设为总是允许'))
    card.querySelector('.btn-deny').addEventListener('click', () => decide('deny', '拒绝'))
    turn.wrapEl.insertBefore(card, turn.bodyEl)
    scrollToBottom()
  }

  // —— 轮次结束 —— //

  /**
   * 结束一轮：去掉光标、追加用量注脚、恢复输入态。
   * @param {any} msg turn_done / turn_error（带 reason、costUsd、usage）。
   */
  function finishTurn(msg) {
    const turn = currentTurn
    if (turn && turn.requestId === msg.requestId) {
      turn.bodyEl.classList.remove('cursor-blink')
      // 折叠思维链（结束后默认收起，避免占屏）。
      if (turn.reasoningEl) {
        const details = turn.reasoningEl.parentElement
        if (details) details.open = false
      }
      // 用量/成本注脚（仅在有意义时展示）。
      if (msg.reason && msg.reason !== 'error') {
        const footer = document.createElement('div')
        footer.className = 'turn-footer'
        footer.textContent = buildFooterText(msg)
        turn.wrapEl.appendChild(footer)
      }
    }
    if (!msg.requestId || !activeRequestId || msg.requestId === activeRequestId) {
      setBusy(false)
    }
    currentTurn = null
    scrollToBottom()
  }

  /**
   * 构造轮次注脚文本（结束原因 + 成本 + token）。
   * @param {any} msg turn_done 消息。
   * @returns {string} 注脚文本。
   */
  function buildFooterText(msg) {
    const parts = []
    if (msg.reason === 'max_iterations') parts.push('已达最大迭代')
    else if (msg.reason === 'aborted') parts.push('已中断')
    if (typeof msg.costUsd === 'number' && msg.costUsd > 0) {
      parts.push('约 $' + msg.costUsd.toFixed(4))
    } else if (typeof msg.costUsd === 'number') {
      parts.push('免费')
    }
    if (msg.usage && typeof msg.usage.totalTokens === 'number') {
      parts.push(msg.usage.totalTokens + ' tokens')
    }
    return parts.join(' · ') || '完成'
  }

  /**
   * 切换忙碌状态：禁用/启用发送、显示/隐藏停止按钮。
   * @param {boolean} busy 是否忙碌。
   * @param {string} [requestId] 关联轮次 id。
   */
  function setBusy(busy, requestId) {
    activeRequestId = busy ? requestId || activeRequestId : null
    sendBtn.classList.toggle('hidden', busy)
    stopBtn.classList.toggle('hidden', !busy)
    inputEl.disabled = false // 仍允许输入下一条（提交时会拦截并发）。
    hintEl.textContent = busy ? 'DCODE 正在处理…' : ''
  }

  /**
   * 显示/更新「内核启动中」瞬时状态行（带固定 id，全程仅一条）。
   * 与 showSystemLine 的「永久行」不同：本行可被 clearKernelStatus 整体移除，
   * 用于 ready/error/exit 到达后清场，确保「正在启动后台内核…」不会残留在界面上。
   * @param {string} text 要展示的状态文本。
   */
  function showKernelStatus(text) {
    clearEmptyState()
    let line = messagesEl.querySelector('#kernel-status-line')
    if (!line) {
      line = document.createElement('div')
      line.id = 'kernel-status-line'
      line.className = 'system-line info kernel-status'
      messagesEl.appendChild(line)
    }
    // 带一个简单的脉冲点，直观表达「进行中」。
    line.textContent = ''
    const dot = document.createElement('span')
    dot.className = 'kernel-status-dot'
    const label = document.createElement('span')
    label.textContent = text
    line.appendChild(dot)
    line.appendChild(label)
    scrollToBottom()
  }

  /** 移除「内核启动中」瞬时状态行（若存在）。 */
  function clearKernelStatus() {
    const line = messagesEl.querySelector('#kernel-status-line')
    if (line) line.remove()
  }

  /**
   * 追加一条系统/错误提示行。
   * @param {string} level info | warn | error。
   * @param {string} text 文本。
   */
  function showSystemLine(level, text) {
    clearEmptyState()
    const div = document.createElement('div')
    div.className = 'system-line ' + level
    div.textContent = text
    messagesEl.appendChild(div)
    scrollToBottom()
  }

  /** 滚动消息区到底部。 */
  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  // —— 极简安全 Markdown 渲染 —— //

  /**
   * 将字符串编码为 base64（UTF-8 安全），用于把代码原文塞进 HTML data 属性。
   * @param {string} s 原始字符串。
   * @returns {string} base64 字符串。
   */
  function encodeBase64(s) {
    // 先 encodeURIComponent → unescape 转成 Latin-1，再 btoa，规避 btoa 不支持非 ASCII 的问题。
    try {
      return btoa(unescape(encodeURIComponent(s)))
    } catch {
      return ''
    }
  }

  /**
   * 解码 base64（UTF-8 安全），与 encodeBase64 对应。
   * @param {string} s base64 字符串。
   * @returns {string} 原始字符串。
   */
  function decodeBase64(s) {
    try {
      return decodeURIComponent(escape(atob(s)))
    } catch {
      return ''
    }
  }

  /**
   * HTML 转义（防 XSS）。
   * @param {string} s 原始字符串。
   * @returns {string} 转义后字符串。
   */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  /**
   * 把 Markdown 文本渲染为安全 HTML。
   * 策略：先抽取代码块占位 → 整体转义 → 行内语法替换 → 段落/列表包裹 → 回填代码块。
   * 仅支持常用子集（代码块、行内代码、粗体、斜体、标题、列表、链接），足够对话展示且无脚本风险。
   * @param {string} text 原始 Markdown。
   * @returns {string} HTML 字符串。
   */
  function renderMarkdown(text) {
    if (!text) return ''
    const codeBlocks = []
    // 1) 抽出 ``` 围栏代码块，用占位符替换，避免内部内容被后续规则误伤。
    //    代码块包一层 .code-block 容器并附带操作工具条（复制 / 预览 diff / 应用到编辑器）；
    //    原始代码以 base64 存入 data-code 属性，事件委托时解码使用（避免 HTML 转义往返失真）。
    let work = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length
      const raw = code.replace(/\n$/, '')
      const cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : ''
      const encoded = encodeBase64(raw)
      const langAttr = lang ? ' data-lang="' + escapeHtml(lang) + '"' : ''
      codeBlocks.push(
        '<div class="code-block" data-code="' + encoded + '"' + langAttr + '>' +
          '<div class="code-toolbar">' +
          '<button class="code-btn" data-act="copy" title="复制代码">复制</button>' +
          '<button class="code-btn" data-act="diff" title="与当前文件对比预览">预览 diff</button>' +
          '<button class="code-btn" data-act="apply" title="应用到当前编辑器">应用</button>' +
          '</div>' +
          '<pre><code' + cls + '>' + escapeHtml(raw) + '</code></pre>' +
          '</div>',
      )
      return '\u0000CB' + idx + '\u0000'
    })

    // 2) 抽出行内代码，同样占位保护。
    const inlineCodes = []
    work = work.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length
      inlineCodes.push('<code>' + escapeHtml(code) + '</code>')
      return '\u0000IC' + idx + '\u0000'
    })

    // 3) 整体 HTML 转义（此时代码已被占位符保护）。
    work = escapeHtml(work)

    // 4) 行内语法：粗体、斜体、链接。
    work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    work = work.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // 链接 [text](url)：仅允许 http/https，避免 javascript: 协议。
    work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
    })

    // 5) 按行处理标题与列表，其余按段落包裹。
    const lines = work.split('\n')
    const out = []
    let inList = false
    let para = []
    /** 冲刷当前累积的段落。 */
    const flushPara = () => {
      if (para.length) {
        out.push('<p>' + para.join('<br>') + '</p>')
        para = []
      }
    }
    /** 关闭列表。 */
    const closeList = () => {
      if (inList) {
        out.push('</ul>')
        inList = false
      }
    }
    for (const line of lines) {
      const h = line.match(/^(#{1,4})\s+(.*)$/)
      const li = line.match(/^\s*[-*]\s+(.*)$/)
      if (h) {
        flushPara()
        closeList()
        const level = h[1].length + 2 // h1→h3，避免与面板标题冲突。
        out.push('<h' + level + '>' + h[2] + '</h' + level + '>')
      } else if (li) {
        flushPara()
        if (!inList) {
          out.push('<ul>')
          inList = true
        }
        out.push('<li>' + li[1] + '</li>')
      } else if (line.trim() === '') {
        flushPara()
        closeList()
      } else {
        if (inList) closeList()
        para.push(line)
      }
    }
    flushPara()
    closeList()
    let html = out.join('\n')

    // 6) 回填行内代码与代码块占位符。
    html = html.replace(/\u0000IC(\d+)\u0000/g, (_, i) => inlineCodes[Number(i)] || '')
    html = html.replace(/\u0000CB(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)] || '')
    return html
  }

  // 通知扩展宿主：前端已就绪，可以开始回放缓冲消息。
  vscode.postMessage({ type: 'webview_ready' })
})()
