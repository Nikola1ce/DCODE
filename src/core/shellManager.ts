// 后台 Shell 进程生命周期管理器。
// 负责 run_command(background) 启动的后台进程：注册 shell_id、累积输出、
// 超时自动终止、历史记录清理，供 bash_output / kill_shell 与 UI 面板查询。
// 制作人：Moriarty_Dox

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_BACKGROUND_SHELL_RECORDS,
  MAX_BACKGROUND_SHELL_RUNTIME_MS,
  MAX_SHELL_OUTPUT_CHARS,
} from '../constants.js'
import { truncate } from '../tools/util.js'

/** 后台 Shell 运行状态。 */
export type ShellStatus = 'running' | 'completed' | 'failed' | 'killed' | 'timeout'

/** 单条后台 Shell 记录。 */
export interface ShellRecord {
  /** 唯一 shell_id（8 位短 id）。 */
  id: string
  /** 执行的命令字符串。 */
  command: string
  /** 命令用途说明。 */
  description?: string
  /** 工作目录。 */
  cwd: string
  /** 当前状态。 */
  status: ShellStatus
  /** 累积输出（stdout + stderr）。 */
  output: string
  /** 退出码；未结束时为 null。 */
  exitCode: number | null
  /** 创建时间戳（毫秒）。 */
  createdAt: number
  /** 进程结束时间戳（毫秒）。 */
  endedAt?: number
  /** 子进程 pid（若可用）。 */
  pid?: number
}

/** 启动后台 Shell 的选项。 */
export interface SpawnShellOptions {
  /** 命令字符串。 */
  command: string
  /** 工作目录。 */
  cwd: string
  /** 用途说明。 */
  description?: string
  /** 超时毫秒数；默认使用 MAX_BACKGROUND_SHELL_RUNTIME_MS。 */
  timeoutMs?: number
  /** 输出增量回调（供 UI 实时展示）。 */
  onOutput?: (text: string) => void
}

/** bash_output 查询选项。 */
export interface GetOutputOptions {
  /** true 时仅返回自上次 tail 查询以来的增量输出。 */
  tail?: boolean
}

/** bash_output 查询结果。 */
export interface ShellOutputSnapshot {
  /** 是否存在该 shell_id。 */
  found: boolean
  /** 记录快照。 */
  record?: ShellRecord
  /** 是否已结束。 */
  done: boolean
  /** 格式化给模型的文本。 */
  formatted: string
  /** 是否为错误状态。 */
  isError: boolean
}

/**
 * 后台 Shell 管理器：管理所有后台进程的生命周期。
 * 生产环境使用全局单例 shellManager；测试可 new ShellManager() 隔离实例。
 */
export class ShellManager {
  private records = new Map<string, ShellRecord>()
  private processes = new Map<string, ChildProcess>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** tail 模式下各 shell_id 已读到的输出字符偏移。 */
  private readOffsets = new Map<string, number>()

  /**
   * 获取所有仍在运行的 Shell 记录。
   * @returns 运行中记录数组（按创建时间倒序）。
   */
  getRunningShells(): ShellRecord[] {
    return [...this.records.values()]
      .filter((r) => r.status === 'running')
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 获取全部 Shell 记录（含已结束，按创建时间倒序）。
   * @returns 记录数组。
   */
  getAllShells(): ShellRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 按 id 查找 Shell 记录。
   * @param id shell_id。
   * @returns 记录或 undefined。
   */
  getShell(id: string): ShellRecord | undefined {
    return this.records.get(id)
  }

  /**
   * 在后台启动 Shell 进程，立即返回 shell_id。
   * @param opts 启动选项。
   * @returns shell_id。
   */
  spawnBackground(opts: SpawnShellOptions): string {
    this.purgeStaleRecords()

    const id = randomUUID().slice(0, 8)
    const record: ShellRecord = {
      id,
      command: opts.command,
      description: opts.description,
      cwd: opts.cwd,
      status: 'running',
      output: '',
      exitCode: null,
      createdAt: Date.now(),
    }
    this.records.set(id, record)

    const timeoutMs = opts.timeoutMs ?? MAX_BACKGROUND_SHELL_RUNTIME_MS
    const child = spawnShellProcess(opts.command, opts.cwd)
    this.processes.set(id, child)
    if (child.pid) record.pid = child.pid

    const appendOutput = (text: string) => {
      record.output += text
      opts.onOutput?.(text)
    }

    child.stdout?.on('data', (chunk: Buffer) => appendOutput(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => appendOutput(chunk.toString()))

    const timer = setTimeout(() => {
      if (record.status === 'running') {
        record.status = 'timeout'
        record.endedAt = Date.now()
        child.kill('SIGKILL')
        this.cleanupProcess(id)
      }
    }, timeoutMs)
    this.timers.set(id, timer)

    child.on('close', (code) => {
      this.clearTimer(id)
      this.processes.delete(id)
      if (record.status !== 'running') return
      record.exitCode = code
      record.endedAt = Date.now()
      record.status = code === 0 ? 'completed' : 'failed'
    })

    child.on('error', (err) => {
      this.clearTimer(id)
      this.processes.delete(id)
      if (record.status !== 'running') return
      record.status = 'failed'
      record.exitCode = null
      record.endedAt = Date.now()
      record.output += `\n[启动失败: ${err.message}]`
    })

    return id
  }

  /**
   * 获取 Shell 输出快照；可选阻塞等待结束或 tail 增量模式。
   * @param id shell_id。
   * @param blockUntilMs 阻塞等待毫秒数，0 表示立即返回当前状态。
   * @param options tail=true 时仅返回自上次 tail 查询以来的新增输出。
   * @returns 输出快照。
   */
  async getOutput(
    id: string,
    blockUntilMs = 0,
    options?: GetOutputOptions,
  ): Promise<ShellOutputSnapshot> {
    const record = this.records.get(id)
    if (!record) {
      return {
        found: false,
        done: true,
        formatted: `错误：未找到 shell_id "${id}"。`,
        isError: true,
      }
    }

    if (blockUntilMs > 0 && record.status === 'running') {
      await waitForShellDone(record, blockUntilMs)
    }

    const tail = options?.tail ?? false
    if (tail) {
      const offset = this.readOffsets.get(id) ?? 0
      const incremental = record.output.slice(offset)
      this.readOffsets.set(id, record.output.length)
      return formatShellSnapshot(record, { tailMode: true, incrementalOutput: incremental })
    }

    return formatShellSnapshot(record)
  }

  /**
   * 终止指定后台 Shell。
   * @param id shell_id。
   * @returns 是否成功发起终止。
   */
  kill(id: string): { ok: boolean; message: string } {
    const record = this.records.get(id)
    if (!record) {
      return { ok: false, message: `未找到 shell_id "${id}"` }
    }
    if (record.status !== 'running') {
      return {
        ok: false,
        message: `Shell ${id} 已结束（状态: ${record.status}，退出码: ${record.exitCode ?? 'N/A'}）`,
      }
    }

    const child = this.processes.get(id)
    if (child) {
      child.kill('SIGKILL')
    }
    record.status = 'killed'
    record.endedAt = Date.now()
    this.clearTimer(id)
    this.processes.delete(id)
    return { ok: true, message: `已终止后台 Shell ${id}` }
  }

  /** 清除超时定时器。 */
  private clearTimer(id: string): void {
    const t = this.timers.get(id)
    if (t) {
      clearTimeout(t)
      this.timers.delete(id)
    }
  }

  /** 清理进程引用与定时器。 */
  private cleanupProcess(id: string): void {
    this.clearTimer(id)
    this.processes.delete(id)
  }

  /**
   *  purge 超出数量上限或已过期的历史记录（不删除运行中的）。
   */
  private purgeStaleRecords(): void {
    const now = Date.now()
    const all = [...this.records.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt)

    for (const [id, rec] of all) {
      if (rec.status === 'running') continue
      const age = now - (rec.endedAt ?? rec.createdAt)
      if (age > MAX_BACKGROUND_SHELL_RUNTIME_MS * 2) {
        this.records.delete(id)
      }
    }

    if (this.records.size <= MAX_BACKGROUND_SHELL_RECORDS) return

    const finished = all.filter(([, r]) => r.status !== 'running')
    for (const [id] of finished.slice(MAX_BACKGROUND_SHELL_RECORDS)) {
      this.records.delete(id)
    }
  }
}

/** 全局 Shell 管理器单例。 */
export const shellManager = new ShellManager()

/**
 * 根据平台 spawn Shell 子进程（与 run_command 一致）。
 * @param command 命令字符串。
 * @param cwd 工作目录。
 * @returns ChildProcess 实例。
 */
export function spawnShellProcess(command: string, cwd: string): ChildProcess {
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'powershell.exe' : '/bin/sh'
  const args = isWindows
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-c', command]

  return spawn(shell, args, {
    cwd,
    env: process.env,
    windowsHide: true,
  })
}

/**
 * 阻塞等待 Shell 结束或超时。
 * @param record Shell 记录。
 * @param maxWaitMs 最大等待毫秒数。
 */
function waitForShellDone(record: ShellRecord, maxWaitMs: number): Promise<void> {
  if (record.status !== 'running') return Promise.resolve()

  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      if (record.status !== 'running') {
        resolve()
        return
      }
      if (Date.now() - start >= maxWaitMs) {
        resolve()
        return
      }
      setTimeout(check, 200)
    }
    check()
  })
}

/**
 * 将 Shell 记录格式化为给模型/UI 的文本。
 * @param record Shell 记录。
 * @param opts tailMode 为 true 时仅展示 incrementalOutput。
 * @returns 输出快照。
 */
function formatShellSnapshot(
  record: ShellRecord,
  opts?: { tailMode?: boolean; incrementalOutput?: string },
): ShellOutputSnapshot {
  const done = record.status !== 'running'
  const tailMode = opts?.tailMode ?? false

  let outputSection: string
  if (tailMode) {
    const inc = (opts?.incrementalOutput ?? '').trim()
    const shown = inc ? truncate(inc, MAX_SHELL_OUTPUT_CHARS) : ''
    outputSection = shown ? `新增输出：\n${shown}` : '（无新增输出）'
  } else {
    const output = truncate(record.output.trim(), MAX_SHELL_OUTPUT_CHARS)
    outputSection = `输出：\n${output || '（尚无输出）'}`
  }

  let header: string
  switch (record.status) {
    case 'running':
      header = `Shell ${record.id} 仍在运行中。`
      break
    case 'completed':
      header = `Shell ${record.id} 已完成（退出码 0）。`
      break
    case 'failed':
      header = `Shell ${record.id} 已结束（退出码 ${record.exitCode}，可能失败）。`
      break
    case 'killed':
      header = `Shell ${record.id} 已被终止。`
      break
    case 'timeout':
      header = `Shell ${record.id} 超时被终止。`
      break
    default:
      header = `Shell ${record.id} 状态: ${record.status}`
  }

  const meta = [
    `命令: $ ${record.command}`,
    record.description ? `说明: ${record.description}` : null,
    `cwd: ${record.cwd}`,
    record.pid ? `pid: ${record.pid}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  const formatted = `${header}\n${meta}\n\n${outputSection}`
  const isError =
    record.status === 'failed' ||
    record.status === 'killed' ||
    record.status === 'timeout'

  return { found: true, record, done, formatted, isError: done && isError }
}

/**
 * 渲染 /shells 命令的状态文本。
 * @returns 多行状态报告。
 */
export function renderShellsStatus(): string {
  const running = shellManager.getRunningShells()
  const all = shellManager.getAllShells()
  if (all.length === 0) {
    return '当前无后台 Shell 记录。'
  }

  const lines = all.slice(0, 15).map((r) => {
    const dur = r.endedAt
      ? `${((r.endedAt - r.createdAt) / 1000).toFixed(1)}s`
      : `${((Date.now() - r.createdAt) / 1000).toFixed(1)}s…`
    const desc = r.description ? ` — ${r.description}` : ''
    return `  ${r.id}  [${r.status.padEnd(9)}] $ ${r.command.slice(0, 50)}${desc} (${dur})`
  })

  return [
    `后台 Shell（运行中 ${running.length}，共 ${all.length} 条）：`,
    ...lines,
    all.length > 15 ? `  … 另有 ${all.length - 15} 条历史记录` : '',
    '',
    '提示：bash_output(shell_id, tail=true) 获取增量输出；kill_shell(shell_id) 终止进程。',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 前台命令执行超时默认值（供 run_command 复用）。 */
export { DEFAULT_COMMAND_TIMEOUT_MS }
