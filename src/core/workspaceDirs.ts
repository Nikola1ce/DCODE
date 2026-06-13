// 额外工作目录管理（/add-dir 命令的存储与校验后端）。
// 将用户通过 /add-dir 显式授权的目录持久化到项目 <cwd>/.dcode/workspace.json，
// 使同一项目下次启动时自动恢复。这些目录会被注入 ToolContext.extraDirs，
// 从而让 read_file / write_file / edit_file / glob / grep / list_dir 等文件工具
// 可以安全地访问工作目录之外、但经用户授权的目录。
// 安全约束：仅记录“目录”（非文件），并在加载时过滤掉已不存在的路径。
// 制作人：Moriarty_Dox

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { CONFIG_DIR_NAME, WORKSPACE_DIRS_FILE_NAME } from '../constants.js'

/** workspace.json 的磁盘结构。 */
interface WorkspaceDirsFile {
  /** 额外授权目录的绝对路径列表。 */
  dirs: string[]
}

/** /add-dir 操作结果。 */
export interface AddDirResult {
  /** 是否成功（已添加或已存在均视为可用）。 */
  ok: boolean
  /** 解析后的绝对路径（成功时存在）。 */
  resolved?: string
  /** 该目录此前是否已在列表中。 */
  alreadyPresent?: boolean
  /** 失败原因（ok 为 false 时存在）。 */
  error?: string
}

/** 移除目录的结果。 */
export interface RemoveDirResult {
  /** 是否确实移除了某项。 */
  removed: boolean
  /** 解析后的绝对路径。 */
  resolved: string
}

/**
 * 返回项目额外目录配置文件绝对路径（<cwd>/.dcode/workspace.json）。
 * @param cwd 工作目录。
 * @returns 绝对路径。
 */
export function getWorkspaceDirsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, WORKSPACE_DIRS_FILE_NAME)
}

/**
 * 将输入路径解析为绝对路径（相对路径基于 cwd）。
 * @param cwd 工作目录。
 * @param inputPath 输入路径。
 * @returns 绝对路径。
 */
function toAbsolute(cwd: string, inputPath: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
}

/**
 * 从磁盘读取已持久化的额外目录列表（不做存在性过滤）。
 * 文件不存在或损坏时返回空数组，保证调用方稳健。
 * @param cwd 工作目录。
 * @returns 绝对路径数组。
 */
function readRawDirs(cwd: string): string[] {
  const path = getWorkspaceDirsPath(cwd)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkspaceDirsFile>
    if (!parsed || !Array.isArray(parsed.dirs)) return []
    // 仅保留字符串项并去重。
    return dedupe(parsed.dirs.filter((d): d is string => typeof d === 'string' && d.length > 0))
  } catch {
    return []
  }
}

/**
 * 将额外目录列表写回磁盘（自动创建 .dcode 目录）。
 * @param cwd 工作目录。
 * @param dirs 绝对路径数组。
 */
function writeDirs(cwd: string, dirs: string[]): void {
  const path = getWorkspaceDirsPath(cwd)
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const payload: WorkspaceDirsFile = { dirs: dedupe(dirs) }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
}

/**
 * 加载当前项目有效的额外工作目录（已过滤掉不存在或非目录的项）。
 * 供 Agent 启动时初始化 extraDirs 使用。
 * @param cwd 工作目录。
 * @returns 仍然有效的绝对目录路径数组。
 */
export function loadExtraDirs(cwd: string): string[] {
  const raw = readRawDirs(cwd)
  return raw.filter((d) => {
    try {
      return existsSync(d) && statSync(d).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 添加一个额外工作目录并持久化。
 * 会校验：路径存在、是目录、且不等于（也不重复于）当前工作目录。
 * @param cwd 当前工作目录。
 * @param inputPath 用户输入的目录路径（相对或绝对）。
 * @returns 操作结果。
 */
export function addExtraDir(cwd: string, inputPath: string): AddDirResult {
  const trimmed = inputPath.trim()
  if (!trimmed) {
    return { ok: false, error: '请提供要添加的目录路径。' }
  }
  const abs = toAbsolute(cwd, trimmed)

  if (!existsSync(abs)) {
    return { ok: false, error: `目录不存在：${trimmed}` }
  }
  try {
    if (!statSync(abs).isDirectory()) {
      return { ok: false, error: `不是目录：${trimmed}（/add-dir 仅接受目录）` }
    }
  } catch {
    return { ok: false, error: `无法访问：${trimmed}` }
  }

  // 与当前工作目录相同则无需添加。
  const realAbs = safeRealpath(abs)
  const realCwd = safeRealpath(toAbsolute(cwd, '.'))
  if (realAbs === realCwd) {
    return { ok: false, error: '该目录即当前工作目录，无需添加。' }
  }

  const existing = readRawDirs(cwd)
  // 基于真实路径判断是否已存在，避免同一目录的不同写法重复。
  const alreadyPresent = existing.some((d) => safeRealpath(d) === realAbs)
  if (alreadyPresent) {
    return { ok: true, resolved: abs, alreadyPresent: true }
  }

  writeDirs(cwd, [...existing, abs])
  return { ok: true, resolved: abs, alreadyPresent: false }
}

/**
 * 从额外目录列表中移除一个目录并持久化。
 * @param cwd 当前工作目录。
 * @param inputPath 用户输入的目录路径（相对或绝对）。
 * @returns 移除结果。
 */
export function removeExtraDir(cwd: string, inputPath: string): RemoveDirResult {
  const abs = toAbsolute(cwd, inputPath.trim())
  const realAbs = safeRealpath(abs)
  const existing = readRawDirs(cwd)
  const next = existing.filter((d) => safeRealpath(d) !== realAbs && d !== inputPath.trim())
  const removed = next.length !== existing.length
  if (removed) writeDirs(cwd, next)
  return { removed, resolved: abs }
}

/**
 * 清空全部额外目录并持久化。
 * @param cwd 当前工作目录。
 * @returns 被清除的目录数量。
 */
export function clearExtraDirs(cwd: string): number {
  const existing = readRawDirs(cwd)
  if (existing.length === 0) return 0
  writeDirs(cwd, [])
  return existing.length
}

/**
 * 渲染额外目录列表为可读文本（供 /add-dir list 展示）。
 * @param cwd 当前工作目录。
 * @param activeDirs 当前会话生效的目录（来自 Agent）。
 * @returns 多行文本。
 */
export function renderExtraDirsList(cwd: string, activeDirs: string[]): string {
  if (activeDirs.length === 0) {
    return [
      '当前没有额外工作目录。',
      '',
      '用法：/add-dir <目录路径>   添加目录到工作上下文（项目级持久化）',
      '      /add-dir list         查看已添加目录',
      '      /add-dir remove <路径> 移除某个目录',
    ].join('\n')
  }
  const lines = activeDirs.map((d, i) => `  ${i + 1}. ${d}`)
  return [
    `额外工作目录（${activeDirs.length}，已加入当前会话上下文）：`,
    ...lines,
    '',
    `持久化于：${getWorkspaceDirsPath(cwd)}`,
    '移除：/add-dir remove <路径>',
  ].join('\n')
}

/**
 * 安全 realpath：路径存在时返回真实路径，否则（或失败时）回退原值。
 * 便于对不存在路径做幂等比较，避免抛错。
 * @param p 绝对路径。
 * @returns 真实路径或原值。
 */
function safeRealpath(p: string): string {
  try {
    return existsSync(p) ? realpathSync(p) : p
  } catch {
    return p
  }
}

/**
 * 数组去重（保序）。
 * @param arr 输入数组。
 * @returns 去重后的数组。
 */
function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr))
}
