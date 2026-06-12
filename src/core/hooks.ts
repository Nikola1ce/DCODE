// Hooks 钩子系统核心。
// 从 ~/.dcode/hooks.json、项目 .dcode/hooks.json 及 hooks/ 目录加载钩子配置，
// 在工具执行前后、会话起止时触发 shell 命令或 prompt 模板验证。
// PreToolUse 可阻止执行或修改入参；PostToolUse 可校验/改写结果；Notification 非阻塞。
// 制作人：Moriarty_Dox

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config.js'
import { CONFIG_DIR_NAME, HOOKS_CONFIG_FILE_NAME } from '../constants.js'
import { createSafeChildEnv } from './childEnv.js'
import { isProjectConfigTrusted } from './projectTrust.js'
import type { ToolResult } from './types.js'

/** 支持的钩子事件类型。 */
export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'OnSessionStart'
  | 'OnSessionEnd'

/** 钩子实现方式：command 直接执行 shell；prompt 渲染模板后通过 command 校验。 */
export type HookImplementationType = 'command' | 'prompt'

/** 单条钩子定义（来自 hooks.json 或 hooks/*.json）。 */
export interface HookEntry {
  /** 可选标识，便于 /hooks 展示。 */
  id?: string
  /** 触发事件。 */
  event: HookEventType
  /** 工具名正则（PreToolUse/PostToolUse/Notification 可选过滤）。 */
  matcher?: string
  /** 实现类型。 */
  type: HookImplementationType
  /** shell 命令（Windows 用 cmd / PowerShell，Unix 用 sh -c）。 */
  command: string
  /** prompt 模板（type=prompt 时使用，支持 {{tool_name}}、{{input_json}} 等占位符）。 */
  prompt?: string
  /** 执行超时（毫秒），默认 30000。 */
  timeout?: number
  /** 是否启用，默认 true。 */
  enabled?: boolean
}

/** hooks.json 根结构。 */
export interface HooksConfigFile {
  /** 全局开关，false 时跳过所有钩子。 */
  enabled?: boolean
  /** 钩子列表。 */
  hooks?: HookEntry[]
}

/** PreToolUse 钩子 stdout 返回 JSON 结构。 */
export interface PreToolUseHookResponse {
  /** continue 放行；block 阻止工具执行。 */
  action?: 'continue' | 'block'
  /** 阻止原因（回传给模型）。 */
  reason?: string
  /** 修改后的工具入参（可选）。 */
  updatedInput?: Record<string, unknown>
}

/** PostToolUse 钩子 stdout 返回 JSON 结构。 */
export interface PostToolUseHookResponse {
  action?: 'continue'
  /** 修改后的工具结果（可选）。 */
  updatedResult?: Partial<ToolResult>
}

/** 传给钩子的 stdin JSON 上下文。 */
export interface HookContextPayload {
  event: HookEventType
  cwd: string
  sessionId?: string | null
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: ToolResult
  notification?: string
  timestamp: number
}

/** PreToolUse 聚合结果。 */
export interface PreToolUseResult {
  /** 是否被钩子阻止。 */
  blocked: boolean
  /** 阻止原因。 */
  reason?: string
  /** 可能被钩子修改后的入参。 */
  input: Record<string, unknown>
  /** 各钩子 stderr/stdout 摘要（调试用）。 */
  logs: string[]
}

/** PostToolUse 聚合结果。 */
export interface PostToolUseResult {
  result: ToolResult
  logs: string[]
}

/** 已加载钩子的运行时状态（供 /hooks 展示）。 */
export interface LoadedHookInfo {
  id: string
  event: HookEventType
  matcher?: string
  type: HookImplementationType
  command: string
  source: string
  enabled: boolean
}

/** 默认钩子命令超时（毫秒）。 */
const DEFAULT_HOOK_TIMEOUT_MS = 30_000

/** 全局 HookManager 单例。 */
let globalHookManager: HookManager | null = null
/** 是否已执行过 shutdown（防止 exit 钩子与 main 重复触发 OnSessionEnd）。 */
let hooksShutdownDone = false

/**
 * 获取全局 HookManager；未 init 时返回 null。
 * @returns HookManager 或 null。
 */
export function getHookManager(): HookManager | null {
  return globalHookManager
}

/**
 * 初始化并加载钩子（CLI 启动时调用）。
 * @param cwd 工作目录。
 * @param hooksEnabled 全局配置开关（config.hooksEnabled）。
 * @returns HookManager 实例。
 */
export function initHooks(cwd: string, hooksEnabled = true): HookManager {
  hooksShutdownDone = false
  globalHookManager = new HookManager()
  globalHookManager.load(cwd)
  if (!hooksEnabled) {
    globalHookManager.setGlobalEnabled(false)
  }
  return globalHookManager
}

/**
 * 触发 OnSessionEnd 并清理单例（进程退出前调用）。
 * @param cwd 工作目录。
 * @param sessionId 会话 id（可选）。
 */
export async function shutdownHooks(cwd: string, sessionId?: string | null): Promise<void> {
  if (hooksShutdownDone || !globalHookManager) return
  hooksShutdownDone = true
  await globalHookManager.runSessionEnd({ cwd, sessionId: sessionId ?? null })
  globalHookManager = null
}

/**
 * HookManager：加载、匹配、执行钩子。
 */
export class HookManager {
  /** 是否全局启用（来自配置 merged enabled）。 */
  private globalEnabled = true
  /** 已加载的钩子条目（含来源路径）。 */
  private entries: Array<HookEntry & { source: string; resolvedId: string }> = []
  /** 最近一次 load 的工作目录。 */
  private lastCwd = ''

  /**
   * 从磁盘加载钩子配置（全局 + 项目合并）。
   * @param cwd 工作目录。
   */
  load(cwd: string): void {
    this.lastCwd = cwd
    this.entries = []
    this.globalEnabled = true

    const sources: Array<{ path: string; label: string }> = [
      { path: getGlobalHooksConfigPath(), label: 'global' },
    ]
    // 项目级 Hooks 可执行任意 shell 命令，仅在用户显式信任该项目时加载。
    if (isProjectConfigTrusted(cwd)) {
      sources.push({ path: getProjectHooksConfigPath(cwd), label: 'project' })
    }

    for (const { path, label } of sources) {
      const cfg = readHooksFile(path)
      if (cfg.enabled === false) this.globalEnabled = false
      this.mergeHooks(cfg.hooks ?? [], `${label}:${path}`)
    }

    // 扫描 hooks/ 目录下的额外 .json 文件（全局始终；项目需信任）。
    this.scanHooksDirectory(getGlobalHooksDir())
    if (isProjectConfigTrusted(cwd)) {
      this.scanHooksDirectory(getProjectHooksDir(cwd))
    }
  }

  /**
   * 重新加载钩子（/hooks reload）。
   * @param cwd 工作目录。
   */
  reload(cwd: string): void {
    this.load(cwd)
  }

  /**
   * 是否全局启用钩子。
   * @returns 启用返回 true。
   */
  isEnabled(): boolean {
    return this.globalEnabled
  }

  /**
   * 设置全局启用开关（来自 config.hooksEnabled）。
   * @param enabled 是否启用。
   */
  setGlobalEnabled(enabled: boolean): void {
    this.globalEnabled = enabled
  }

  /**
   * 返回已加载钩子列表（供 /hooks 展示）。
   * @returns LoadedHookInfo 数组。
   */
  listHooks(): LoadedHookInfo[] {
    return this.entries.map((e) => ({
      id: e.resolvedId,
      event: e.event,
      matcher: e.matcher,
      type: e.type,
      command: e.command,
      source: e.source,
      enabled: e.enabled !== false,
    }))
  }

  /**
   * 返回最近一次 load 的 cwd。
   * @returns 工作目录。
   */
  getLastCwd(): string {
    return this.lastCwd
  }

  /**
   * 执行 PreToolUse 钩子链。
   * @param toolName 工具名。
   * @param input 解析后的入参。
   * @param ctx 上下文（cwd、sessionId）。
   * @returns 是否阻止、修改后入参、日志。
   */
  async runPreToolUse(
    toolName: string,
    input: Record<string, unknown>,
    ctx: { cwd: string; sessionId?: string | null },
  ): Promise<PreToolUseResult> {
    if (!this.globalEnabled) return { blocked: false, input, logs: [] }

    let currentInput = { ...input }
    const logs: string[] = []
    const hooks = this.matchHooks('PreToolUse', toolName)

    for (const hook of hooks) {
      const payload: HookContextPayload = {
        event: 'PreToolUse',
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        toolName,
        toolInput: currentInput,
        timestamp: Date.now(),
      }
      const { stdout, stderr, exitCode } = await this.executeHook(hook, payload, currentInput)
      if (stderr) logs.push(stderr.trim())
      if (stdout) logs.push(stdout.trim())

      const parsed = parseHookJson<PreToolUseHookResponse>(stdout)
      if (parsed?.updatedInput && typeof parsed.updatedInput === 'object') {
        currentInput = { ...currentInput, ...parsed.updatedInput }
      }
      if (parsed?.action === 'block') {
        return {
          blocked: true,
          reason: parsed.reason ?? `钩子 ${hook.resolvedId} 阻止了工具 ${toolName}`,
          input: currentInput,
          logs,
        }
      }
      // 非零退出码且无 JSON：视为阻止（保守策略）。
      if (exitCode !== 0 && !parsed) {
        return {
          blocked: true,
          reason: `钩子 ${hook.resolvedId} 退出码 ${exitCode}${stderr ? `：${stderr.trim()}` : ''}`,
          input: currentInput,
          logs,
        }
      }
    }

    return { blocked: false, input: currentInput, logs }
  }

  /**
   * 执行 PostToolUse 钩子链。
   * @param toolName 工具名。
   * @param input 工具入参。
   * @param result 工具执行结果。
   * @param ctx 上下文。
   * @returns 可能被修改的结果与日志。
   */
  async runPostToolUse(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    ctx: { cwd: string; sessionId?: string | null },
  ): Promise<PostToolUseResult> {
    if (!this.globalEnabled) return { result, logs: [] }

    let currentResult = { ...result }
    const logs: string[] = []
    const hooks = this.matchHooks('PostToolUse', toolName)

    for (const hook of hooks) {
      const payload: HookContextPayload = {
        event: 'PostToolUse',
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        toolName,
        toolInput: input,
        toolResult: currentResult,
        timestamp: Date.now(),
      }
      const { stdout, stderr } = await this.executeHook(hook, payload, input)
      if (stderr) logs.push(stderr.trim())
      if (stdout) logs.push(stdout.trim())

      const parsed = parseHookJson<PostToolUseHookResponse>(stdout)
      if (parsed?.updatedResult) {
        currentResult = { ...currentResult, ...parsed.updatedResult }
      }
    }

    return { result: currentResult, logs }
  }

  /**
   * 触发 Notification 钩子（非阻塞，fire-and-forget）。
   * @param message 通知内容。
   * @param ctx 上下文。
   * @param toolName 可选关联工具名。
   */
  runNotification(
    message: string,
    ctx: { cwd: string; sessionId?: string | null },
    toolName?: string,
  ): void {
    if (!this.globalEnabled) return
    const hooks = this.matchHooks('Notification', toolName)
    for (const hook of hooks) {
      const payload: HookContextPayload = {
        event: 'Notification',
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        toolName,
        notification: message,
        timestamp: Date.now(),
      }
      void this.executeHook(hook, payload, {}).catch(() => {
        // Notification 失败静默忽略。
      })
    }
  }

  /**
   * 触发 OnSessionStart 钩子。
   * @param ctx 上下文。
   */
  async runSessionStart(ctx: { cwd: string; sessionId?: string | null }): Promise<string[]> {
    if (!this.globalEnabled) return []
    return this.runLifecycleHooks('OnSessionStart', ctx)
  }

  /**
   * 触发 OnSessionEnd 钩子。
   * @param ctx 上下文。
   */
  async runSessionEnd(ctx: { cwd: string; sessionId?: string | null }): Promise<string[]> {
    if (!this.globalEnabled) return []
    return this.runLifecycleHooks('OnSessionEnd', ctx)
  }

  /**
   * 执行会话生命周期钩子。
   * @param event OnSessionStart 或 OnSessionEnd。
   * @param ctx 上下文。
   * @returns 日志摘要。
   */
  private async runLifecycleHooks(
    event: 'OnSessionStart' | 'OnSessionEnd',
    ctx: { cwd: string; sessionId?: string | null },
  ): Promise<string[]> {
    const logs: string[] = []
    const hooks = this.matchHooks(event)
    for (const hook of hooks) {
      const payload: HookContextPayload = {
        event,
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        timestamp: Date.now(),
      }
      try {
        const { stdout, stderr } = await this.executeHook(hook, payload, {})
        if (stderr) logs.push(stderr.trim())
        if (stdout) logs.push(stdout.trim())
      } catch (e: any) {
        logs.push(`钩子 ${hook.resolvedId} 失败：${e.message}`)
      }
    }
    return logs
  }

  /**
   * 按事件与工具名匹配钩子。
   * @param event 事件类型。
   * @param toolName 工具名（可选）。
   * @returns 匹配的钩子列表。
   */
  private matchHooks(event: HookEventType, toolName?: string): Array<HookEntry & { source: string; resolvedId: string }> {
    return this.entries.filter((e) => {
      if (e.enabled === false) return false
      if (e.event !== event) return false
      if (!e.matcher || !toolName) return true
      try {
        return new RegExp(e.matcher).test(toolName)
      } catch {
        return e.matcher === toolName
      }
    })
  }

  /**
   * 执行单条钩子（spawn 子进程）。
   * @param hook 钩子定义。
   * @param payload stdin JSON 上下文。
   * @param toolInput 当前工具入参（prompt 模板用）。
   * @returns stdout、stderr、exitCode。
   */
  private executeHook(
    hook: HookEntry & { source: string; resolvedId: string },
    payload: HookContextPayload,
    toolInput: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeout = hook.timeout ?? DEFAULT_HOOK_TIMEOUT_MS
    const stdinJson = JSON.stringify(payload)
    const renderedPrompt =
      hook.type === 'prompt' && hook.prompt
        ? renderPromptTemplate(hook.prompt, payload, toolInput)
        : undefined

    const env = {
      ...createSafeChildEnv(),
      DCODE_HOOK_EVENT: payload.event,
      DCODE_HOOK_CWD: payload.cwd,
      ...(renderedPrompt ? { DCODE_HOOK_PROMPT: renderedPrompt } : {}),
    }

    return new Promise((resolve, reject) => {
      const { shell, args } = buildShellInvocation(hook.command)
      const child = spawn(shell, args, {
        cwd: payload.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`钩子 ${hook.resolvedId} 超时（${timeout}ms）`))
      }, timeout)

      child.stdin?.write(stdinJson)
      child.stdin?.end()

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      })
    })
  }

  /**
   * 合并钩子列表到 entries。
   * @param hooks 钩子数组。
   * @param source 来源标识。
   */
  private mergeHooks(hooks: HookEntry[], source: string): void {
    for (let i = 0; i < hooks.length; i++) {
      const h = hooks[i]
      if (!h.event || !h.command) continue
      const resolvedId = h.id ?? `${h.event}-${this.entries.length + i}`
      this.entries.push({ ...h, source, resolvedId })
    }
  }

  /**
   * 扫描目录下所有 .json 钩子文件。
   * @param dir 目录路径。
   */
  private scanHooksDirectory(dir: string): void {
    if (!existsSync(dir)) return
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      return
    }
    for (const file of files) {
      const path = join(dir, file)
      const cfg = readHooksFile(path)
      if (cfg.enabled === false) this.globalEnabled = false
      this.mergeHooks(cfg.hooks ?? [], `dir:${path}`)
    }
  }
}

/**
 * 全局 hooks.json 路径（~/.dcode/hooks.json）。
 * @returns 绝对路径。
 */
export function getGlobalHooksConfigPath(): string {
  return join(getConfigDir(), HOOKS_CONFIG_FILE_NAME)
}

/**
 * 项目 hooks.json 路径（<cwd>/.dcode/hooks.json）。
 * @param cwd 工作目录。
 * @returns 绝对路径。
 */
export function getProjectHooksConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, HOOKS_CONFIG_FILE_NAME)
}

/**
 * 全局 hooks 目录（~/.dcode/hooks/）。
 * @returns 绝对路径。
 */
export function getGlobalHooksDir(): string {
  return join(getConfigDir(), 'hooks')
}

/**
 * 项目 hooks 目录（<cwd>/.dcode/hooks/）。
 * @param cwd 工作目录。
 * @returns 绝对路径。
 */
export function getProjectHooksDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, 'hooks')
}

/**
 * 读取单个 hooks 配置文件。
 * @param path 文件路径。
 * @returns 解析后的配置；失败返回空。
 */
function readHooksFile(path: string): HooksConfigFile {
  if (!existsSync(path)) return { hooks: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<HooksConfigFile>
    const hooks = Array.isArray(raw.hooks) ? raw.hooks : []
    return { enabled: raw.enabled, hooks: hooks as HookEntry[] }
  } catch {
    return { hooks: [] }
  }
}

/**
 * 从 stdout 解析钩子 JSON 响应（取首个 JSON 对象）。
 * @param stdout 子进程标准输出。
 * @returns 解析结果或 null。
 */
function parseHookJson<T>(stdout: string): T | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  // 尝试整段解析。
  try {
    return JSON.parse(trimmed) as T
  } catch {
    // 尝试提取首个 { ... } 块。
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0]) as T
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * 渲染 prompt 模板占位符。
 * @param template 模板字符串。
 * @param payload 钩子上下文。
 * @param toolInput 工具入参。
 * @returns 渲染后的 prompt。
 */
function renderPromptTemplate(
  template: string,
  payload: HookContextPayload,
  toolInput: Record<string, unknown>,
): string {
  return template
    .replace(/\{\{tool_name\}\}/g, payload.toolName ?? '')
    .replace(/\{\{input_json\}\}/g, JSON.stringify(toolInput))
    .replace(/\{\{event\}\}/g, payload.event)
    .replace(/\{\{cwd\}\}/g, payload.cwd)
    .replace(/\{\{notification\}\}/g, payload.notification ?? '')
}

/**
 * 根据平台构造 shell 调用参数。
 * Windows 下优先用 cmd /c，避免 PowerShell 对引号/转义的破坏。
 * @param command 用户配置的命令字符串。
 * @returns shell 与 args。
 */
function buildShellInvocation(command: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  return { shell: 'sh', args: ['-c', command] }
}

/**
 * 渲染 /hooks 状态文本。
 * @param mgr HookManager。
 * @returns 多行文本。
 */
export function renderHooksStatus(mgr: HookManager): string {
  const hooks = mgr.listHooks()
  const lines = [
    `Hooks 全局开关：${mgr.isEnabled() ? '启用' : '禁用'}`,
    `配置文件：${getGlobalHooksConfigPath()}`,
    `项目配置：${getProjectHooksConfigPath(mgr.getLastCwd())}`,
    `已加载钩子：${hooks.length} 条`,
    '',
  ]
  if (hooks.length === 0) {
    lines.push(
      '（未配置钩子。可在 ~/.dcode/hooks.json 或 .dcode/hooks.json 中添加，',
      '或在 ~/.dcode/hooks/、.dcode/hooks/ 目录放置 .json 文件。）',
      '',
      '子命令：reload',
    )
    return lines.join('\n')
  }
  for (const h of hooks) {
    const matcher = h.matcher ? ` matcher=${h.matcher}` : ''
    lines.push(
      `  [${h.id}] ${h.event}${matcher} (${h.type})`,
      `    cmd: ${h.command.slice(0, 80)}${h.command.length > 80 ? '…' : ''}`,
      `    src: ${h.source}`,
    )
  }
  lines.push('', '子命令：/hooks reload')
  return lines.join('\n')
}
