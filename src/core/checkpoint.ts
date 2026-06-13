// 文件检查点与回滚管理。
// write_file / edit_file 执行前自动备份原文件到 .dcode/checkpoints/，
// 支持 /checkpoints 查看与 /undo 回退最近 N 次写操作。
// 制作人：Moriarty_Dox

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR_NAME } from '../constants.js'
import { toDisplayPath } from '../tools/util.js'

/** 触发检查点的工具名。 */
export type CheckpointTool = 'write_file' | 'edit_file' | 'notebook_edit'

/** 单条检查点记录（写入 manifest.json）。 */
export interface CheckpointRecord {
  /** 唯一 id，对应 data 目录下的备份文件名。 */
  id: string
  /** 创建时间戳（毫秒）。 */
  timestamp: number
  /** 目标文件相对路径（相对 cwd，/ 分隔）。 */
  targetPath: string
  /** 触发备份的工具。 */
  tool: CheckpointTool
  /** 备份字节数（新文件为 0）。 */
  bytes: number
  /** 操作前文件是否不存在（undo 时删除该文件）。 */
  wasNewFile: boolean
}

/** undo 操作结果。 */
export interface UndoResult {
  /** 成功恢复的文件相对路径。 */
  restored: string[]
  /** undo「新建文件」时删除的路径。 */
  deleted: string[]
  /** 实际回退的检查点数量。 */
  count: number
  /** 失败项说明。 */
  errors: string[]
}

/** 检查点子目录名（位于 .dcode/checkpoints/）。 */
const CHECKPOINTS_FOLDER = 'checkpoints'
/** manifest 文件名。 */
const MANIFEST_NAME = 'manifest.json'
/** 备份数据子目录。 */
const DATA_FOLDER = 'data'
/** 最大保留检查点数量，超出时丢弃最旧记录。 */
const MAX_CHECKPOINTS = 200

/**
 * 返回项目检查点根目录绝对路径（<cwd>/.dcode/checkpoints）。
 * @param cwd 工作目录。
 * @returns 绝对路径。
 */
export function getCheckpointsDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, CHECKPOINTS_FOLDER)
}

/**
 * 返回 manifest.json 绝对路径。
 * @param cwd 工作目录。
 * @returns 绝对路径。
 */
function getManifestPath(cwd: string): string {
  return join(getCheckpointsDir(cwd), MANIFEST_NAME)
}

/**
 * 返回备份数据目录绝对路径。
 * @param cwd 工作目录。
 * @returns 绝对路径。
 */
function getDataDir(cwd: string): string {
  return join(getCheckpointsDir(cwd), DATA_FOLDER)
}

/**
 * 返回单条备份文件的绝对路径。
 * @param cwd 工作目录。
 * @param id 检查点 id。
 * @returns 绝对路径。
 */
function getBackupPath(cwd: string, id: string): string {
  return join(getDataDir(cwd), `${id}.bak`)
}

/**
 * 确保检查点目录结构存在。
 * @param cwd 工作目录。
 */
function ensureCheckpointDirs(cwd: string): void {
  const root = getCheckpointsDir(cwd)
  const data = getDataDir(cwd)
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  if (!existsSync(data)) mkdirSync(data, { recursive: true })
}

/**
 * 从磁盘读取 manifest；损坏或不存在时返回空数组。
 * @param cwd 工作目录。
 * @returns 检查点记录列表（按时间顺序，旧→新）。
 */
function loadManifest(cwd: string): CheckpointRecord[] {
  const path = getManifestPath(cwd)
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(isValidRecord)
  } catch {
    return []
  }
}

/**
 * 将 manifest 写回磁盘。
 * @param cwd 工作目录。
 * @param records 检查点列表。
 */
function saveManifest(cwd: string, records: CheckpointRecord[]): void {
  ensureCheckpointDirs(cwd)
  writeFileSync(getManifestPath(cwd), JSON.stringify(records, null, 2), 'utf8')
}

/**
 * 校验对象是否为合法 CheckpointRecord。
 * @param value 待校验值。
 * @returns 合法返回 true。
 */
function isValidRecord(value: unknown): value is CheckpointRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as CheckpointRecord
  return (
    typeof r.id === 'string' &&
    typeof r.timestamp === 'number' &&
    typeof r.targetPath === 'string' &&
    (r.tool === 'write_file' || r.tool === 'edit_file') &&
    typeof r.bytes === 'number' &&
    typeof r.wasNewFile === 'boolean'
  )
}

/**
 * 生成检查点 id（时间戳 + 随机 hex）。
 * @returns id 字符串。
 */
function generateCheckpointId(): string {
  return `${Date.now()}-${randomBytes(4).toString('hex')}`
}

/**
 * 将绝对路径转为 cwd 内相对路径（/ 分隔，供 manifest 存储）。
 * @param cwd 工作目录。
 * @param absPath 绝对路径。
 * @returns 相对路径字符串。
 */
function toRelativePath(cwd: string, absPath: string): string {
  return toDisplayPath(cwd, absPath)
}

/**
 * 将 manifest 中的相对路径解析为绝对路径。
 * @param cwd 工作目录。
 * @param relPath 相对路径。
 * @returns 绝对路径。
 */
function resolveTargetAbs(cwd: string, relPath: string): string {
  const parts = relPath.split('/').filter((p) => p !== '' && p !== '.')
  return parts.length === 0 ? cwd : join(cwd, ...parts)
}

/**
 * 删除单条备份文件（忽略不存在）。
 * @param cwd 工作目录。
 * @param id 检查点 id。
 */
function deleteBackupFile(cwd: string, id: string): void {
  const path = getBackupPath(cwd, id)
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      // 忽略删除失败。
    }
  }
}

/**
 * 写操作执行前创建检查点（备份当前文件内容）。
 * @param cwd 工作目录。
 * @param absPath 目标文件绝对路径（须已在 cwd 内）。
 * @param tool 触发工具名。
 * @returns 新建的检查点记录。
 */
export function saveCheckpointBeforeWrite(
  cwd: string,
  absPath: string,
  tool: CheckpointTool,
): CheckpointRecord {
  ensureCheckpointDirs(cwd)
  const records = loadManifest(cwd)
  const id = generateCheckpointId()
  const rel = toRelativePath(cwd, absPath)
  const fileExists = existsSync(absPath)

  let bytes = 0
  if (fileExists) {
    const content = readFileSync(absPath)
    bytes = content.length
    writeFileSync(getBackupPath(cwd, id), content)
  }

  const record: CheckpointRecord = {
    id,
    timestamp: Date.now(),
    targetPath: rel,
    tool,
    bytes,
    wasNewFile: !fileExists,
  }

  records.push(record)

  // 超出上限时移除最旧记录及其备份文件。
  while (records.length > MAX_CHECKPOINTS) {
    const removed = records.shift()
    if (removed) deleteBackupFile(cwd, removed.id)
  }

  saveManifest(cwd, records)
  return record
}

/**
 * 列出当前项目全部检查点（旧→新）。
 * @param cwd 工作目录。
 * @returns 检查点记录数组。
 */
export function listCheckpoints(cwd: string): CheckpointRecord[] {
  return loadManifest(cwd)
}

/**
 * 返回检查点数量。
 * @param cwd 工作目录。
 * @returns 数量。
 */
export function getCheckpointCount(cwd: string): number {
  return loadManifest(cwd).length
}

/**
 * 回退最近 N 个检查点（LIFO，从最新开始逐条 undo）。
 * @param cwd 工作目录。
 * @param count 回退数量。
 * @returns 回退结果摘要。
 */
export function undoCheckpoints(cwd: string, count: number): UndoResult {
  const records = loadManifest(cwd)
  if (records.length === 0) {
    return { restored: [], deleted: [], count: 0, errors: ['没有可回退的检查点。'] }
  }

  const n = Math.min(Math.max(1, Math.floor(count)), records.length)
  const toUndo = records.slice(-n).reverse()
  const remaining = records.slice(0, -n)

  const result: UndoResult = { restored: [], deleted: [], count: 0, errors: [] }
  const failedRecords: typeof records = []

  for (const cp of toUndo) {
    const abs = resolveTargetAbs(cwd, cp.targetPath)
    try {
      if (cp.wasNewFile) {
        if (existsSync(abs)) {
          unlinkSync(abs)
          result.deleted.push(cp.targetPath)
        }
        result.count++
      } else {
        const backupPath = getBackupPath(cwd, cp.id)
        if (!existsSync(backupPath)) {
          result.errors.push(`备份丢失：${cp.targetPath}（id=${cp.id}）`)
          failedRecords.push(cp)
          continue
        }
        const content = readFileSync(backupPath)
        const parent = dirname(abs)
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
        writeFileSync(abs, content)
        result.restored.push(cp.targetPath)
        result.count++
      }
      deleteBackupFile(cwd, cp.id)
    } catch (e: any) {
      result.errors.push(`${cp.targetPath}：${e.message}`)
      failedRecords.push(cp)
    }
  }

  // 恢复失败的检查点保留在 manifest 中，便于用户再次 /undo。
  saveManifest(cwd, [...remaining, ...failedRecords.reverse()])
  return result
}

/**
 * 清空全部检查点及备份文件。
 * @param cwd 工作目录。
 * @returns 清除的记录数。
 */
export function clearCheckpoints(cwd: string): number {
  const records = loadManifest(cwd)
  for (const cp of records) {
    deleteBackupFile(cwd, cp.id)
  }
  if (records.length > 0) {
    saveManifest(cwd, [])
  }
  return records.length
}

/**
 * 格式化时间为本地可读字符串。
 * @param ts 毫秒时间戳。
 * @returns 格式化文本。
 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 渲染 /checkpoints 列表文本。
 * @param cwd 工作目录。
 * @returns 多行文本。
 */
export function renderCheckpointList(cwd: string): string {
  const records = listCheckpoints(cwd)
  if (records.length === 0) {
    return [
      '（暂无文件检查点）',
      '',
      `检查点目录：${getCheckpointsDir(cwd)}`,
      'write_file / edit_file 执行前会自动备份；使用 /undo 回退。',
      '子命令：/checkpoints clear 清空全部备份',
    ].join('\n')
  }

  const lines = [`文件检查点（共 ${records.length} 条，最新在末尾）：`]
  records.forEach((cp, i) => {
    const size = cp.wasNewFile ? '（新建）' : `${cp.bytes} B`
    lines.push(
      `  ${String(i + 1).padStart(3)}. [${formatTime(cp.timestamp)}] ${cp.targetPath}`,
      `       ${cp.tool} · ${size}`,
    )
  })
  lines.push('')
  lines.push('用法：/undo [N] 回退最近 N 个检查点（默认 1）')
  lines.push('      /checkpoints clear 清空全部备份')
  return lines.join('\n')
}

/**
 * 渲染 undo 结果文本。
 * @param result undoCheckpoints 返回值。
 * @returns 多行文本。
 */
export function renderUndoResult(result: UndoResult): string {
  if (result.count === 0 && result.errors.length > 0) {
    return result.errors.join('\n')
  }
  const parts: string[] = [`已回退 ${result.count} 个检查点。`]
  if (result.restored.length > 0) {
    parts.push(`恢复文件：${result.restored.join('、')}`)
  }
  if (result.deleted.length > 0) {
    parts.push(`删除新建文件：${result.deleted.join('、')}`)
  }
  if (result.errors.length > 0) {
    parts.push(`警告：\n${result.errors.map((e) => `  - ${e}`).join('\n')}`)
  }
  return parts.join('\n')
}

/**
 * 会话结束时若有未清理检查点，返回提示文本。
 * @param cwd 工作目录。
 * @returns 提示文本；无检查点时返回 null。
 */
export function getCheckpointExitHint(cwd: string): string | null {
  const n = getCheckpointCount(cwd)
  if (n === 0) return null
  return (
    `[检查点] 当前项目有 ${n} 个文件检查点。` +
    `可用 /checkpoints 查看、/undo 回退、/checkpoints clear 清理。`
  )
}
