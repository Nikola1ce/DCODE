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
  const statusModel = document.getElementById('status-model')
  const statusMode = document.getElementById('status-mode')
  const hintEl = document.getElementById('hint')

  // —— 运行期状态 —— //
  // 当前进行中的轮次 id（用于停止与把流式增量归并到正确的消息块）。
  let activeRequestId = null
  // 当前轮次的助手消息 DOM 上下文：{ requestId, bodyEl, rawText, reasoningEl, reasoningText, toolEls: Map }
  let currentTurn = null
  // 权限模式中文名映射。
  const MODE_LABELS = {
    default: '逐次确认',
    acceptEdits: '自动编辑',
    plan: '只读规划',
    bypass: '跳过确认',
  }

  // 启动时展示空状态。
  renderEmptyState()

  // —— 输入交互 —— //
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
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
   * 提交输入框内容，发起一轮对话。
   */
  function submit() {
    const text = inputEl.value.trim()
    if (!text) return
    if (activeRequestId) return // 进行中时禁止并发提交。
    vscode.postMessage({ type: 'send', text })
    inputEl.value = ''
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
        updateStatus(msg.model, msg.permissionMode)
        break
      case 'user_message':
        clearEmptyState()
        appendUserMessage(msg.text)
        beginAssistantTurn(msg.requestId)
        setBusy(true, msg.requestId)
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
        showSystemLine('info', '正在启动后台内核…')
        break
      case 'kernel_error':
        showSystemLine('error', '内核启动失败：' + (msg.message || ''))
        break
      case 'kernel_exit':
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
   * 处理 ready：更新状态栏、按需提示缺少 API Key。
   * @param {any} msg ready 消息。
   */
  function onReady(msg) {
    updateStatus(msg.model, msg.permissionMode)
    if (!msg.hasApiKey) {
      showSystemLine(
        'warn',
        '尚未配置可用的 API Key。请在终端运行 dcode 后用 /login 配置，或设置相应环境变量后点击重启。',
      )
    }
  }

  /**
   * 更新顶部状态栏的模型名与权限模式。
   * @param {string} model 模型名。
   * @param {string} mode 权限模式。
   */
  function updateStatus(model, mode) {
    if (model) statusModel.textContent = 'DCODE · ' + model
    if (mode) statusMode.textContent = '· ' + (MODE_LABELS[mode] || mode)
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
      '<div>选中代码后右键可使用「解释 / 修复 / 重构」。</div>'
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
   */
  function appendUserMessage(text) {
    const wrap = document.createElement('div')
    wrap.className = 'msg user'
    wrap.innerHTML =
      '<div class="msg-role">你</div>' +
      '<div class="msg-body">' +
      renderMarkdown(text) +
      '</div>'
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
