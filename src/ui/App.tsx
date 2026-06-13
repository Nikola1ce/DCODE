// 主界面 App 组件（Ink TUI 的根）。
// 职责：编排全局状态机（输入 / 运行 / 权限确认 / 各交互流程），驱动 Agent 单轮对话，
// 把 Agent 的流式回调映射为 React 状态更新，并渲染历史区(Static)、实时区、任务面板、
// 输入框与底部状态栏。是整套终端交互的中枢。
// 制作人：Moriarty_Dox

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink'
import type { DCodeConfig } from '../config.js'
import { updateConfig } from '../config.js'
import type { Agent } from '../core/agent.js'
import type {
  PermissionDecision,
  PermissionRequest,
  TodoItem,
} from '../core/types.js'
import {
  buildProviderLoginPatch,
  getActiveProviderId,
  getModelSelectOptions,
  getProviderDefinition,
  getProviderLoginMeta,
} from '../providers/registry.js'
import { getModelContextWindow } from '../providers/contextWindow.js'
import { isSlashCommand, runSlashCommand, type SlashCommandResult } from '../commands/index.js'
import { estimateMessagesTokens } from '../core/compact.js'
import { buildStartupUpdateNotice, checkForUpdate } from '../core/updater.js'
import { listSessions, loadSessionMessages } from '../core/session.js'
import { messagesToItems } from './messagesToItems.js'
import { getTheme, ThemeContext } from './theme.js'
import { useTerminalBackground } from './terminalBackground.js'
import { Banner } from './Banner.js'
import { MessageView } from './MessageView.js'
import { InputPrompt } from './InputPrompt.js'
import { PermissionPrompt } from './PermissionPrompt.js'
import { LoginPrompt } from './LoginPrompt.js'
import { Select } from './Select.js'
import { StatusLine, Spinner } from './StatusLine.js'
import { TodoPanel } from './TodoPanel.js'
import { BackgroundShellPanel } from './BackgroundShellPanel.js'
import { tailByVisualRows } from './textLayout.js'
import { StreamCommitter, type StreamChunk } from './streamCommit.js'
import { appendToolProgress } from './toolProgress.js'
import type { DisplayItem } from './types.js'
import { makeEventKey, isEventDuplicate } from './eventKey.js'
import { traceEvent, traceTextFields } from '../trace.js'

const MAX_PENDING_TOOL_PROGRESS_CHARS = 2000

// App 组件入参。
interface AppProps {
  // 已构造好的 Agent 实例（已注入配置/会话/历史）。
  agent: Agent
  // 初始配置快照。
  config: DCodeConfig
  // 恢复会话时预置的历史展示项（可选）。
  initialItems?: DisplayItem[]
  // 是否在启动时因缺少 API Key 而直接进入登录流程。
  needLogin?: boolean
  // 是否在启动后异步检测 GitHub 新版本并提示（不阻塞首屏渲染）。
  checkUpdateOnStart?: boolean
}

// 当前打开的交互流程类型。
type Flow = null | 'model' | 'login' | 'resume' | 'theme'

// 全局自增 id 生成器，用于 React key。
let _seq = 0
function nextId(): string {
  _seq += 1
  return `i${_seq}`
}

function traceChunk(chunk: StreamChunk): Record<string, unknown> {
  return {
    variant: chunk.variant,
    head: chunk.head,
    spacer: !!chunk.spacer,
    ...traceTextFields('text', chunk.text),
  }
}

/**
 * 构造「恢复会话」选择器的选项列表。
 * @returns 选项数组；无历史时返回一个占位项（value 为空串）。
 */
function buildResumeOptions(): { label: string; value: string; hint?: string }[] {
  const sessions = listSessions(10)
  if (sessions.length === 0) {
    return [{ label: '（暂无历史会话）', value: '' }]
  }
  return sessions.map((s) => ({
    label: s.firstUserText || '(无标题)',
    value: s.id,
    hint: `${s.messageCount} 条 · ${new Date(s.createdAt).toLocaleString()}`,
  }))
}

/**
 * 主界面组件。
 * @param props 入参。
 * @returns 界面 JSX。
 */
export function App({ agent, config, initialItems, needLogin, checkUpdateOnStart }: AppProps): React.ReactElement {
  const { exit } = useApp()

  // —— 配置与主题（UI 级，可热更新）——
  const configRef = useRef<DCodeConfig>(config)
  const [themeName, setThemeName] = useState(config.theme)
  const [showThinking, setShowThinking] = useState(config.showThinking)
  const theme = useMemo(() => getTheme(themeName), [themeName])
  // 终端尺寸：用于限制实时区高度，避免流式内容超过可视高度触发滚动跳变/帧泄漏。
  // 注意：传给 Ink 的 stdout 是「不清屏」代理（rows 被放大以禁用 clearTerminal），
  // 故此处限高逻辑必须直接读真实 process.stdout 的行列数，而非 Ink 提供的代理。
  const { stdout } = useStdout()
  const realStdout = process.stdout as unknown as { rows?: number; columns?: number }
  const termRows = realStdout.rows ?? 24
  const termCols = realStdout.columns ?? 80
  // 随主题同步终端窗口底色（亮色主题切换为浅灰底，避免黑字不可见）。
  useTerminalBackground(themeName, stdout)

  // —— 历史展示项（进入 Static，避免重渲染闪烁）——
  const [items, setItems] = useState<DisplayItem[]>(
    initialItems && initialItems.length > 0
      ? initialItems
      : [{ id: nextId(), kind: 'banner', model: agent.getModel(), cwd: agent.cwd }],
  )

  // —— 实时区：流式文本/思维链、运行中的工具 ——
  // 说明：实时区只保留「正在输入的最后一行（未完成尾巴）」；已完成的整行会被逐块
  // 提交到 Static 历史，使输出像普通命令输出一样流入滚动区、终端跟随到底部。
  const [liveText, setLiveText] = useState('')
  const [liveReasoning, setLiveReasoning] = useState('')
  // 流式分块提交器：每轮对话新建一个，负责把已完成整行落 Static、维护未完成尾巴与首块状态。
  const committerRef = useRef<StreamCommitter | null>(null)
  const [runningTool, setRunningTool] = useState<{
    summary: string
    progress: string
  } | null>(null)
  const toolProgressBufferRef = useRef('')
  const toolProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // —— 运行状态 ——
  const [busy, setBusy] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [cost, setCost] = useState(agent.usage.costUsd)
  // 当前会话已使用的上下文 token（估算值），用于状态栏上下文进度条；初始按现有历史估算。
  const [contextTokens, setContextTokens] = useState(() =>
    estimateMessagesTokens(agent.getMessages()),
  )
  const [model, setModelState] = useState(agent.getModel())
  // 当前模型的上下文窗口大小（token）：作为状态栏进度条的总量上限。
  // 随模型/Provider 切换重算（model 变化即触发），而非固定用压缩阈值，避免上限失真。
  const contextLimit = useMemo(
    () => getModelContextWindow(getActiveProviderId(configRef.current), model),
    [model],
  )
  const [permissionMode, setPermissionModeState] = useState(agent.permissionMode)
  const [todos, setTodos] = useState<TodoItem[]>(agent.getTodos())

  // —— 权限确认 ——
  const [permissionReq, setPermissionReq] = useState<PermissionRequest | null>(null)
  const permissionResolverRef = useRef<((d: PermissionDecision) => void) | null>(null)

  // —— 交互流程 ——
  const [flow, setFlow] = useState<Flow>(needLogin ? 'login' : null)

  // —— 中断控制 ——
  const abortRef = useRef<AbortController | null>(null)

  // —— 输入历史 ——
  const inputHistoryRef = useRef<string[]>([])

  // 工具调用摘要缓存：id -> 摘要文本（onToolEnd 时取用）。
  const toolSummaryRef = useRef<Map<string, string>>(new Map())
  const toolNameRef = useRef<Map<string, string>>(new Map())

  /** 向历史追加一个展示项。 */
  const pushItem = useCallback((item: DisplayItem) => {
    setItems((prev) => [...prev, item])
  }, [])

  /** 追加一条系统提示。 */
  const pushSystem = useCallback(
    (tone: 'info' | 'success' | 'error' | 'warning', text: string) => {
      setItems((prev) => [...prev, { id: nextId(), kind: 'system', tone, text }])
    },
    [],
  )

  /**
   * 重新估算当前会话上下文占用并刷新状态栏进度条。
   * 在每轮对话结束、压缩、清空等会改变消息历史的时机调用，保证显示与实际一致。
   */
  const refreshContextTokens = useCallback(() => {
    setContextTokens(estimateMessagesTokens(agent.getMessages()))
  }, [agent])

  // 启动后异步检测新版本（使用缓存，不阻塞 TUI 首屏）。
  useEffect(() => {
    if (!checkUpdateOnStart) return
    let cancelled = false
    void checkForUpdate({ timeoutMs: 5000 })
      .then((check) => buildStartupUpdateNotice(check))
      .then((notice) => {
        if (!cancelled && notice) pushSystem('info', notice)
      })
      .catch(() => {
        // 检测失败时静默忽略，避免干扰正常使用。
      })
    return () => {
      cancelled = true
    }
  }, [checkUpdateOnStart, pushSystem])

  /** 持久化并热更新配置。 */
  const applyConfig = useCallback((patch: Partial<DCodeConfig>) => {
    const next = updateConfig(patch)
    configRef.current = next
    agent.applyConfigPatch(patch)
    // 同步可能影响 UI 的字段。
    if (patch.theme) setThemeName(patch.theme)
    if (patch.showThinking !== undefined) setShowThinking(patch.showThinking)
    if (patch.model) setModelState(patch.model)
  }, [agent])

  /** 请求用户授权：命中白名单自动放行，否则弹窗等待决策。 */
  const requestPermission = useCallback(
    (req: PermissionRequest): Promise<PermissionDecision> => {
      return new Promise<PermissionDecision>((resolve) => {
        if (configRef.current.alwaysAllow.includes(req.ruleKey)) {
          resolve('allow_once')
          return
        }
        permissionResolverRef.current = resolve
        // 把「标题 + 预览」一次性落入 Static 历史：完整展示、可上滑查看，且不参与动态区重绘，
        // 从而避免高预览在动态区反复重绘时产生残影（Bug 2）。动态区只保留下方的选择项。
        setItems((prev) => [
          ...prev,
          { id: nextId(), kind: 'permission', title: req.title, preview: req.preview },
        ])
        setPermissionReq(req)
      })
    },
    [],
  )

  /** 处理用户的权限决策。 */
  const handleDecision = useCallback(
    (decision: PermissionDecision) => {
      const req = permissionReq
      // “总是允许”写入白名单并持久化。
      if (decision === 'allow_always' && req) {
        const next = updateConfig({
          alwaysAllow: [...configRef.current.alwaysAllow, req.ruleKey],
        })
        configRef.current = next
      }
      setPermissionReq(null)
      const resolve = permissionResolverRef.current
      permissionResolverRef.current = null
      resolve?.(decision)
    },
    [permissionReq],
  )

  /** 把分块列表追加到 Static 历史（一次状态更新提交多块，减少重渲染）。 */
  const pushStreamChunks = useCallback((chunks: StreamChunk[]) => {
    if (chunks.length === 0) return
    traceEvent('app', 'static_push', {
      chunkCount: chunks.length,
      chunks: chunks.map(traceChunk),
    })
    setItems((prev) => [
      ...prev,
      ...chunks.map((c) => ({ id: nextId(), kind: 'stream' as const, ...c })),
    ])
  }, [])

  const clearToolProgressTimer = useCallback(() => {
    if (toolProgressTimerRef.current) {
      clearTimeout(toolProgressTimerRef.current)
      toolProgressTimerRef.current = null
    }
  }, [])

  const flushToolProgress = useCallback(() => {
    const pending = toolProgressBufferRef.current
    toolProgressBufferRef.current = ''
    clearToolProgressTimer()
    if (!pending) return
    setRunningTool((prev) =>
      prev
        ? { ...prev, progress: appendToolProgress(prev.progress, pending) }
        : prev,
    )
  }, [clearToolProgressTimer])

  const enqueueToolProgress = useCallback(
    (text: string) => {
      const next = toolProgressBufferRef.current + text
      toolProgressBufferRef.current = next.slice(-MAX_PENDING_TOOL_PROGRESS_CHARS)
      if (!toolProgressTimerRef.current) {
        toolProgressTimerRef.current = setTimeout(flushToolProgress, 120)
      }
    },
    [flushToolProgress],
  )

  useEffect(() => {
    return () => {
      clearToolProgressTimer()
    }
  }, [clearToolProgressTimer])

  /** 驱动 Agent 执行一轮对话。 */
  const runAgent = useCallback(
    async (prompt: string) => {
      setBusy(true)
      setStatusText('正在思考')
      const ac = new AbortController()
      abortRef.current = ac
      // 每轮新建分块提交器并清空实时区。
      const committer = new StreamCommitter(showThinking)
      committerRef.current = committer
      setLiveText('')
      setLiveReasoning('')
      // 幂等去重：同一轮 run 中每个事件只应被处理一次。若 AgentRunner 内部重试
      // 或同一事件被二次 yield（本轮不应发生，但防御性处理），跳过已处理过的。
      const processedKeys = new Set<string>()

      try {
        await agent.runTurn(prompt, {
          onEvent: (ev) => {
            // 幂等去重：只有需要去重的事件（tool_*、assistant_message 等）才检查。
            // text_delta / reasoning_delta 永远不跳过（makeEventKey 返回 null）。
            const key = makeEventKey(ev)
            const traceContext = {
              runId: ev.runId,
              turnId: ev.turnId,
              iteration: 'iteration' in ev ? ev.iteration : undefined,
            }
            traceEvent('app', 'on_event_received', {
              eventType: ev.type,
              key,
              ...(ev.type === 'text_delta' || ev.type === 'reasoning_delta'
                ? traceTextFields('delta', ev.delta)
                : {}),
            }, traceContext)
            if (isEventDuplicate(key, processedKeys)) {
              traceEvent('app', 'on_event_skipped_duplicate', { eventType: ev.type, key }, traceContext)
              return
            }
            if (key !== null) processedKeys.add(key)
            committer.setTraceContext(traceContext)

            // 同步处理旧版回调（向后兼容，onEvent 与旧回调不会同时存在，
            // 因为 agent.runTurn 的实现是先调 handleRunEventForCompatibility 再调 onEvent，
            // 故旧回调不会被执行；但此处主动检查以保证 onEvent 被注册时能完整覆盖）。
            if (ev.type === 'reasoning_delta') {
              const chunks = committer.onReasoning(ev.delta)
              traceEvent('app', 'reasoning_delta_committed', {
                chunkCount: chunks.length,
                chunks: chunks.map(traceChunk),
                ...traceTextFields('liveReasoning', committer.liveReasoning),
              }, traceContext)
              pushStreamChunks(chunks)
              setLiveReasoning(committer.liveReasoning)
              setStatusText('正在推理')
            } else if (ev.type === 'text_delta') {
              const chunks = committer.onText(ev.delta)
              traceEvent('app', 'text_delta_committed', {
                chunkCount: chunks.length,
                chunks: chunks.map(traceChunk),
                ...traceTextFields('liveText', committer.liveText),
                ...traceTextFields('liveReasoning', committer.liveReasoning),
              }, traceContext)
              pushStreamChunks(chunks)
              setLiveReasoning(committer.liveReasoning)
              setLiveText(committer.liveText)
              setStatusText('正在回答')
            } else if (ev.type === 'assistant_message') {
              const chunks = committer.onDone()
              traceEvent('app', 'assistant_message_done_committed', {
                chunkCount: chunks.length,
                chunks: chunks.map(traceChunk),
              }, traceContext)
              pushStreamChunks(chunks)
              setLiveText('')
              setLiveReasoning('')
            } else if (ev.type === 'tool_start') {
              toolSummaryRef.current.set(ev.id, ev.summary)
              toolNameRef.current.set(ev.id, ev.name)
              toolProgressBufferRef.current = ''
              clearToolProgressTimer()
              setRunningTool({ summary: ev.summary, progress: '' })
              setStatusText('执行工具')
            } else if (ev.type === 'tool_progress') {
              enqueueToolProgress(ev.text)
            } else if (ev.type === 'tool_end') {
              toolProgressBufferRef.current = ''
              clearToolProgressTimer()
              const summary = toolSummaryRef.current.get(ev.id) ?? ev.name
              const resultText = ev.result.isError
                ? ev.result.llmContent
                : ev.name === 'run_command'
                  ? ev.result.llmContent
                  : ev.result.uiSummary ?? ev.result.llmContent
              pushItem({
                id: nextId(),
                kind: 'tool',
                name: ev.name,
                summary,
                status: ev.result.isError ? 'error' : 'done',
                resultText,
              })
              setRunningTool(null)
              setTodos(agent.getTodos())
            } else if (ev.type === 'llm_done') {
              setCost(agent.usage.costUsd)
              // 每次模型应答完成后，历史已追加新消息，同步刷新上下文占用进度条。
              refreshContextTokens()
            } else if (ev.type === 'compact_start') {
              setStatusText('正在压缩上下文')
              pushSystem('info', '上下文较长，正在自动压缩以释放空间…')
            }
          },
          requestPermission,
          abortSignal: ac.signal,
        })
      } catch (e: any) {
        // 把异常作为系统错误展示，保持界面可继续使用。
        pushSystem('error', e?.message ? String(e.message) : String(e))
        // 流式失败时，把已产出的未完成尾巴也落块，避免丢失。
        const chunks = committer.onDone()
        traceEvent('app', 'error_done_committed', {
          error: e?.message ? String(e.message) : String(e),
          chunkCount: chunks.length,
          chunks: chunks.map(traceChunk),
        })
        pushStreamChunks(chunks)
      } finally {
        setBusy(false)
        setStatusText('')
        abortRef.current = null
        toolProgressBufferRef.current = ''
        clearToolProgressTimer()
        setRunningTool(null)
        setLiveText('')
        setLiveReasoning('')
        // 本轮结束（含异常/中断/压缩后）统一以最新历史为准刷新上下文进度条。
        refreshContextTokens()
      }
    },
    [
      agent,
      clearToolProgressTimer,
      enqueueToolProgress,
      pushStreamChunks,
      pushSystem,
      refreshContextTokens,
      requestPermission,
      showThinking,
    ],
  )

  /** 处理斜杠命令的执行结果。 */
  const handleCommandResult = useCallback(
    async (result: SlashCommandResult) => {
      if (result.cleared) {
        // 清空历史但保留欢迎横幅。
        setItems([{ id: nextId(), kind: 'banner', model: agent.getModel(), cwd: agent.cwd }])
        setTodos([])
        // 历史被清空（/clear），上下文进度条同步归位到仅剩 system 提示的占用。
        refreshContextTokens()
      }
      if (result.message) {
        pushSystem('info', result.message)
      }
      if (result.openFlow) {
        setFlow(result.openFlow)
      }
      if (result.exit) {
        exit()
        return
      }
      // 同步可能被命令修改的状态。
      setModelState(agent.getModel())
      setPermissionModeState(agent.permissionMode)
      // /compact、/resume 等命令会改写消息历史，统一刷新上下文进度条。
      refreshContextTokens()
      // /init 等命令可能要求代为提交一个 prompt。
      if (result.submitPrompt) {
        await runAgent(result.submitPrompt)
      }
    },
    [agent, exit, pushSystem, refreshContextTokens, runAgent],
  )

  /** 处理输入框提交（区分斜杠命令与普通对话）。 */
  const handleSubmit = useCallback(
    async (input: string) => {
      // 记录输入历史。
      inputHistoryRef.current.push(input)
      // 展示用户消息。
      pushItem({ id: nextId(), kind: 'user', text: input })

      if (isSlashCommand(input)) {
        const result = await runSlashCommand(input, {
          agent,
          config: configRef.current,
          applyConfig,
        })
        await handleCommandResult(result)
        return
      }
      // 无 API Key 时引导先登录。
      if (!agent.hasApiKey()) {
        pushSystem(
          'warning',
          `尚未设置 ${getProviderDefinition(agent.getProviderId()).name} API Key，` +
            `请 /login 或设置环境变量 ${getProviderDefinition(agent.getProviderId()).apiKeyEnv}。`,
        )
        setFlow('login')
        return
      }
      await runAgent(input)
    },
    [agent, applyConfig, handleCommandResult, pushItem, pushSystem, runAgent],
  )

  // 全局按键：仅在运行中且无弹窗/流程时，用 Esc 中断当前请求。
  useInput(
    (_input, key) => {
      if (key.escape && busy && !permissionReq && !flow) {
        abortRef.current?.abort()
        pushSystem('warning', '已请求中断当前操作…')
      }
    },
    { isActive: busy && !permissionReq && !flow },
  )

  // 输入框是否激活：非运行、无弹窗、无流程时才接受输入。
  const inputActive = !busy && !permissionReq && !flow

  // —— 动态区（非 Static）限高：按「视觉行」预算 ——
  // 现在动态区只承载「正在输入的最后一行（未完成尾巴）」：已完成行会逐块落入 Static，
  // 因此动态区天然很矮、终端会随 Static 增长自动跟随到底部。
  // 这里仍按视觉行（计入自动换行 + CJK 全角宽度）对尾巴限高，作为「超长无换行单行」的
  // 安全网，防止其撑高动态区再次触发 Ink 5.2.1 的帧泄漏/视口不跟随。
  // 正文区左侧有「● 」缩进，按 termCols-2 估算更保守。
  const wrapCols = Math.max(20, termCols - 2)
  // 稳定的输出区域 key：权限弹窗出现时整个 App 会重新渲染，
  // 但主输出区（Static + 实时区）被包在独立 Box 中，Ink 只需要重绘底部弹窗，
  // 不会触发 Static 的视口重置，从而避免滚动位置被强制回到顶部。
  const outputKey = 'main-output'

  return (
    <ThemeContext.Provider value={theme}>
      <Box flexDirection="column" width="100%">
        {/* 主输出区域：稳定的独立容器。
            权限弹窗出现时，App 整体重新渲染，但这个 Box 本身不变化，
            Ink 只需要在底部追加弹窗，Static 视口不受影响。 */}
        <Box key={outputKey} flexDirection="column">
          {/* 历史区：已完成的展示项，使用 Static 避免重复渲染 */}
          <Static items={items}>
            {(item) => (
              <MessageView key={item.id} item={item} showThinking={showThinking} />
            )}
          </Static>

          {/* 实时区：运行中的工具及其进度。
              权限弹窗期间工具在等待授权，spinner 改为静态帧——避免 80ms 定时重绘叠加
              较高动态区时产生滚动残影（此时动态区应保持静止，便于用户自由拖动滚动条）。 */}
          {runningTool ? (
            <Box flexDirection="column" marginBottom={1}>
              <Box>
                {permissionReq ? (
                  <Text color={theme.primary}>⠿</Text>
                ) : (
                  <Spinner />
                )}
                <Text color={theme.tool}> {runningTool.summary}</Text>
              </Box>
              {runningTool.progress.trim() ? (
                <Box marginLeft={2}>
                  <Text color={theme.dim}>
                    {tailByVisualRows(runningTool.progress, Math.max(2, Math.min(4, termRows - 8)), wrapCols)}
                  </Text>
                </Box>
              ) : null}
            </Box>
          ) : null}

          {/* 任务清单面板：空闲时窗口化限高，运行中折叠为单行摘要。 */}
          <TodoPanel
            todos={todos}
            compact={busy}
            maxVisible={Math.max(3, Math.min(12, termRows - 9))}
          />

          {/* 后台 Shell 面板：展示 run_command(background) 启动的长任务。 */}
          <BackgroundShellPanel
            compact={busy}
            maxVisible={Math.max(2, Math.min(5, termRows - 12))}
          />
        </Box>

        {/* 交互区域：权限弹窗优先（遮挡在主输出之上）；无弹窗时渲染输入框/状态栏。
            注意：此处不用 key，仅靠组件替换切换，不会触发主输出区重渲染。 */}
        {permissionReq ? (
          <PermissionPrompt onDecision={handleDecision} />
        ) : flow === 'login' ? (
          <LoginPrompt
            {...getProviderLoginMeta(getActiveProviderId(configRef.current))}
            onSubmit={(apiKey) => {
              const id = getActiveProviderId(configRef.current)
              const patch = buildProviderLoginPatch(configRef.current, id, apiKey)
              applyConfig(patch)
              setFlow(null)
              pushSystem(
                'success',
                `${getProviderDefinition(id).name} API Key 已保存，当前 Provider 已生效。`,
              )
            }}
            onCancel={() => setFlow(null)}
          />
        ) : flow === 'model' ? (
          <Select
            title="选择模型"
            options={getModelSelectOptions(configRef.current)}
            onSelect={(m) => {
              agent.setModel(m)
              applyConfig({ model: m })
              setFlow(null)
              pushSystem('success', `已切换模型为 ${m}`)
            }}
            onCancel={() => setFlow(null)}
          />
        ) : flow === 'resume' ? (
          <Select
            title="恢复历史会话"
            options={buildResumeOptions()}
            onSelect={(id) => {
              setFlow(null)
              if (!id) {
                pushSystem('info', '没有可恢复的历史会话。')
                return
              }
              // 载入历史消息到 Agent，并在界面回放。
              const msgs = loadSessionMessages(id)
              agent.replaceMessages(msgs)
              const replay = messagesToItems(msgs)
              setItems([
                { id: nextId(), kind: 'banner', model: agent.getModel(), cwd: agent.cwd },
                ...replay,
              ])
              pushSystem('success', `已恢复会话 ${id.slice(0, 8)}（${msgs.length} 条消息）。`)
            }}
            onCancel={() => setFlow(null)}
          />
        ) : flow === 'theme' ? (
          <Select
            title="选择主题"
            options={[
              { label: '暗色', value: 'dark' as const },
              { label: '亮色', value: 'light' as const },
            ]}
            onSelect={(t) => {
              applyConfig({ theme: t })
              setFlow(null)
              pushSystem('success', `已切换主题为 ${t === 'dark' ? '暗色' : '亮色'}`)
            }}
            onCancel={() => setFlow(null)}
          />
        ) : (
          // 默认渲染输入框 + 状态栏。
          <Box flexDirection="column">
            {inputActive ? (
              <InputPrompt
                onSubmit={handleSubmit}
                isActive={inputActive}
                history={inputHistoryRef.current}
                getConfig={() => configRef.current}
              />
            ) : null}
            <StatusLine
              busy={busy}
              animate={runningTool === null}
              model={model}
              permissionMode={permissionMode}
              costUsd={cost}
              contextTokens={contextTokens}
              contextLimit={contextLimit}
              statusText={statusText}
            />
          </Box>
        )}
      </Box>
    </ThemeContext.Provider>
  )
}
