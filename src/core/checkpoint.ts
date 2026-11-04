// 文件检查点与回滚管理。
// 写入前备份原文件，写入后保存结果快照；结构化查询和回退严格按会话隔离。
// CLI 的 /checkpoints、/undo 保留对无身份历史记录的兼容。
// 制作人：Moriarty_Dox

import { createHash, randomBytes } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { CONFIG_DIR_NAME } from '../constants.js'
import { buildDiffHunks, formatHunkHeader, renderDiffViewText, type DiffHunk } from '../tools/diff.js'

/** 触发检查点的工具名。 */
export type CheckpointTool = 'write_file' | 'edit_file' | 'notebook_edit'
export type CheckpointOperation = 'create' | 'edit' | 'delete'

/** 可直接传入 ToolContext；只持久化身份字段，不保存配置或权限回调。 */
export interface CheckpointIdentity {
  sessionId?: string | null
  runId?: string
  turnId?: string
  toolCallId?: string
}

/** 单条检查点记录（manifest 顺序为旧→新，不依赖时间戳排序）。 */
export interface CheckpointRecord extends CheckpointIdentity {
  id: string
  timestamp: number
  /** 相对 cwd 的规范路径，使用 / 分隔。 */
  targetPath: string
  tool: CheckpointTool
  bytes: number
  wasNewFile: boolean
  sessionId?: string
  beforeHash?: string
  /** undefined 表示尚无写后快照，null 表示写后文件不存在。 */
  afterHash?: string | null
  afterBytes?: number
  /** 传入 identity 的新调用须在写入成功后完成检查点，不能回退未完成写操作。 */
  pending?: boolean
}

/** 面向 IPC 的轻量摘要，不携带文件内容或备份的磁盘路径。 */
export interface CheckpointSummary extends CheckpointIdentity {
  id: string
  timestamp: number
  path: string
  tool: CheckpointTool
  operation: CheckpointOperation
  bytes: number
  afterBytes?: number
  legacy: boolean
  /** 快照是否完整；实时冲突检查仍在回退时执行。 */
  complete: boolean
}

/** 有界的行级差异；省略计算时不伪造 added/removed 为 0。 */
export interface CheckpointFileDiff {
  hunks: DiffHunk[]
  added?: number
  removed?: number
  truncated: boolean
  preview: string
}

export type CheckpointErrorCode =
  | 'invalid_session'
  | 'invalid_id'
  | 'not_found'
  | 'session_mismatch'
  | 'legacy'
  | 'incomplete'
  | 'invalid_path'
  | 'conflict'
  | 'snapshot_missing'
  | 'snapshot_corrupt'
  | 'io_error'

export interface CheckpointFailure {
  code: CheckpointErrorCode
  message: string
  checkpointId?: string
  path?: string
}

export type CheckpointDiffResult =
  | ({ ok: true; checkpoint: CheckpointSummary } & CheckpointFileDiff)
  | { ok: false; code: CheckpointErrorCode; error: string }

/** CLI 兼容结果。count 只计入文件恢复和 manifest 更新均成功的记录。 */
export interface UndoResult {
  restored: string[]
  deleted: string[]
  count: number
  errors: string[]
}

/** 预检失败时 count=0；执行阶段 I/O 失败时可通过 undoneIds 识别已完成的部分。 */
export interface SessionUndoResult extends UndoResult {
  ok: boolean
  undoneIds: string[]
  failures: CheckpointFailure[]
}

const CHECKPOINTS_FOLDER = 'checkpoints'
const MANIFEST_NAME = 'manifest.json'
const DATA_FOLDER = 'data'
const MAX_CHECKPOINTS = 200
const MAX_DIFF_INPUT_BYTES = 512 * 1024
const MAX_DIFF_CELLS = 1_000_000
const MAX_DIFF_LINES = 200
const MAX_DIFF_OUTPUT_BYTES = 48 * 1024
const HASH_RE = /^[a-f0-9]{64}$/
const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

class CheckpointError extends Error {
  constructor(readonly code: CheckpointErrorCode, message: string) {
    super(message)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || /[\\:\0]/.test(path)) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part))
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** 既拒绝词法遍历，也拒绝后来被替换为符号链接/Windows junction 的目录或文件。 */
function resolveSafePath(cwd: string, relPath: string): string {
  if (!isSafeRelativePath(relPath)) {
    throw new CheckpointError('invalid_path', `不安全的检查点路径：${relPath}`)
  }
  let current = realpathSync(cwd)
  for (const part of relPath.split('/')) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new CheckpointError('invalid_path', `检查点路径包含符号链接：${relPath}`)
      }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return current
}

/** 返回项目检查点根目录（兼容原 CLI 接口）。 */
export function getCheckpointsDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, CHECKPOINTS_FOLDER)
}

function storagePath(cwd: string, suffix = ''): string {
  return resolveSafePath(cwd, `${CONFIG_DIR_NAME}/${CHECKPOINTS_FOLDER}${suffix ? `/${suffix}` : ''}`)
}

function getManifestPath(cwd: string): string {
  return storagePath(cwd, MANIFEST_NAME)
}

function getBackupPath(cwd: string, id: string, after = false): string {
  if (!isSafeId(id)) throw new CheckpointError('invalid_id', '检查点 id 非法。')
  return storagePath(cwd, `${DATA_FOLDER}/${id}.${after ? 'after' : 'bak'}`)
}

function ensureCheckpointDirs(cwd: string): void {
  mkdirSync(storagePath(cwd, DATA_FOLDER), { recursive: true })
}

function resolveTargetAbs(cwd: string, relPath: string): string {
  const key = pathKey(relPath)
  const reserved = pathKey(`${CONFIG_DIR_NAME}/${CHECKPOINTS_FOLDER}`)
  if (key === reserved || key.startsWith(`${reserved}/`)) {
    throw new CheckpointError('invalid_path', '检查点不能恢复自身的存储文件。')
  }
  return resolveSafePath(cwd, relPath)
}

function isValidIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !value.includes('\0')
}

function storedIdentity(identity?: CheckpointIdentity): Partial<CheckpointRecord> {
  const result: Partial<CheckpointRecord> = {}
  for (const key of ['sessionId', 'runId', 'turnId', 'toolCallId'] as const) {
    const value = identity?.[key]
    if (value === undefined || (key === 'sessionId' && value === null)) continue
    if (!isValidIdentity(value)) throw new CheckpointError('invalid_session', `检查点身份 ${key} 非法。`)
    result[key] = value
  }
  return result
}

function isValidRecord(value: unknown): value is CheckpointRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as CheckpointRecord
  return (
    isSafeId(r.id) &&
    Number.isFinite(r.timestamp) &&
    isSafeRelativePath(r.targetPath) &&
    (r.tool === 'write_file' || r.tool === 'edit_file' || r.tool === 'notebook_edit') &&
    Number.isSafeInteger(r.bytes) && r.bytes >= 0 &&
    typeof r.wasNewFile === 'boolean' &&
    ['sessionId', 'runId', 'turnId', 'toolCallId'].every((key) => {
      const field = (r as unknown as Record<string, unknown>)[key]
      return field === undefined || isValidIdentity(field)
    }) &&
    (r.beforeHash === undefined || (typeof r.beforeHash === 'string' && HASH_RE.test(r.beforeHash))) &&
    (r.afterHash === undefined || r.afterHash === null || (typeof r.afterHash === 'string' && HASH_RE.test(r.afterHash))) &&
    (r.afterBytes === undefined || (Number.isSafeInteger(r.afterBytes) && r.afterBytes >= 0)) &&
    (r.pending === undefined || typeof r.pending === 'boolean')
  )
}

/** 查询旧 CLI 可容错；写入和回退使用 strict，不能用空 manifest 覆盖损坏的记录。 */
function loadManifest(cwd: string, strict = false): CheckpointRecord[] {
  try {
    let text: string
    try {
      text = readFileSync(getManifestPath(cwd), 'utf8')
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw)) throw new Error('检查点 manifest 不是数组。')
    const valid = raw.filter(isValidRecord)
    if (strict && valid.length !== raw.length) throw new Error('检查点 manifest 含非法记录。')
    const ids = new Set(valid.map((record) => record.id))
    if (ids.size !== valid.length) throw new Error('检查点 manifest 含重复 id。')
    return valid
  } catch (error) {
    if (strict) throw error
    return []
  }
}

/** 原子替换 manifest；写入失败时旧记录仍可用。 */
function saveManifest(cwd: string, records: CheckpointRecord[]): void {
  ensureCheckpointDirs(cwd)
  const target = getManifestPath(cwd)
  const temp = storagePath(cwd, `manifest-${randomBytes(8).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(records, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temp, target)
  } finally {
    try { unlinkSync(temp) } catch { /* 不影响已经提交的 manifest。 */ }
  }
}

function deleteBackupFiles(cwd: string, id: string): void {
  for (const after of [false, true]) {
    try { unlinkSync(getBackupPath(cwd, id, after)) } catch { /* 清理失败不影响回退状态。 */ }
  }
}

interface FileState {
  content: Buffer | null
  hash: string | null
}

function fileState(content: Buffer | null): FileState {
  return { content, hash: content === null ? null : hash(content) }
}

function readFileState(abs: string): FileState {
  try {
    const stat = lstatSync(abs)
    if (!stat.isFile()) throw new CheckpointError('invalid_path', '检查点目标不是普通文件。')
    return fileState(readFileSync(abs))
  } catch (error) {
    if (isMissing(error)) return fileState(null)
    throw error
  }
}

/**
 * 写入前保存原文件。第四参可直接使用 ToolContext；失败返回 undefined，绝不登记无备份记录。
 * 未传 identity 的旧调用仍可通过 CLI /undo 使用；新工具必须在成功写入后调用 completeCheckpointAfterWrite。
 */
export function saveCheckpointBeforeWrite(
  cwd: string,
  absPath: string,
  tool: CheckpointTool,
  identity?: CheckpointIdentity,
): CheckpointRecord | undefined {
  let id: string | undefined
  try {
    const root = realpathSync(cwd)
    const rel = relative(root, absPath).split(sep).join('/')
    const target = resolveTargetAbs(cwd, rel)
    const before = readFileState(target)
    const fields = storedIdentity(identity)
    const records = loadManifest(cwd, true)
    ensureCheckpointDirs(cwd)
    id = `${Date.now()}-${randomBytes(8).toString('hex')}`
    if (before.content !== null) {
      writeFileSync(getBackupPath(cwd, id), before.content, { flag: 'wx', mode: 0o600 })
    }
    const record: CheckpointRecord = {
      id,
      timestamp: Date.now(),
      targetPath: rel,
      tool,
      bytes: before.content?.length ?? 0,
      wasNewFile: before.content === null,
      ...fields,
      ...(before.hash !== null ? { beforeHash: before.hash } : {}),
      ...(identity !== undefined ? { pending: true } : {}),
    }
    records.push(record)
    const removed = records.splice(0, Math.max(0, records.length - MAX_CHECKPOINTS))
    saveManifest(cwd, records)
    for (const old of removed) deleteBackupFiles(cwd, old.id)
    return record
  } catch {
    if (id) deleteBackupFiles(cwd, id)
    return undefined
  }
}

/** 写入成功后固化 after 快照及 hash；失败时保留 pending 备份供人工排查，不提供可回退 id。 */
export function completeCheckpointAfterWrite(
  cwd: string,
  id: string,
  expectedContent?: string | Buffer | null,
): CheckpointRecord | undefined {
  let wroteAfter = false
  try {
    if (!isSafeId(id)) return undefined
    const records = loadManifest(cwd, true)
    const index = records.findIndex((record) => record.id === id)
    if (index < 0) return undefined
    const record = records[index]
    if (record.afterHash !== undefined) return undefined
    readSnapshot(cwd, record, false)
    const after = readFileState(resolveTargetAbs(cwd, record.targetPath))
    if (expectedContent !== undefined) {
      const expected = typeof expectedContent === 'string' ? Buffer.from(expectedContent, 'utf8') : expectedContent
      if (after.hash !== fileState(expected).hash) return undefined
    }
    if (after.content !== null) {
      writeFileSync(getBackupPath(cwd, id, true), after.content, { flag: 'wx', mode: 0o600 })
      wroteAfter = true
    }
    const completed: CheckpointRecord = {
      ...record,
      afterHash: after.hash,
      afterBytes: after.content?.length ?? 0,
      pending: false,
    }
    records[index] = completed
    saveManifest(cwd, records)
    return completed
  } catch {
    if (wroteAfter) {
      try { unlinkSync(getBackupPath(cwd, id, true)) } catch { /* 记录仍为 pending。 */ }
    }
    return undefined
  }
}

/** 工具写入失败时撤销尚未完成的登记，不删除已完成检查点。 */
export function discardPendingCheckpoint(cwd: string, id: string): boolean {
  try {
    if (!isSafeId(id)) return false
    const records = loadManifest(cwd, true)
    const record = records.find((entry) => entry.id === id)
    if (!record || record.afterHash !== undefined) return false
    const beforeHash = record.wasNewFile ? null : record.beforeHash
    if (readFileState(resolveTargetAbs(cwd, record.targetPath)).hash !== beforeHash) return false
    saveManifest(cwd, records.filter((entry) => entry.id !== id))
    deleteBackupFiles(cwd, id)
    return true
  } catch {
    return false
  }
}

/** 返回全部记录，含 legacy；仅供旧 CLI 使用。 */
export function listCheckpoints(cwd: string): CheckpointRecord[] {
  return loadManifest(cwd)
}

export function getCheckpointCount(cwd: string): number {
  return loadManifest(cwd).length
}

function summarize(record: CheckpointRecord): CheckpointSummary {
  return {
    id: record.id,
    timestamp: record.timestamp,
    path: record.targetPath,
    tool: record.tool,
    operation: record.afterHash === null ? 'delete' : record.wasNewFile ? 'create' : 'edit',
    bytes: record.bytes,
    afterBytes: record.afterBytes,
    sessionId: record.sessionId,
    runId: record.runId,
    turnId: record.turnId,
    toolCallId: record.toolCallId,
    legacy: !record.sessionId,
    complete: record.afterHash !== undefined && !record.pending,
  }
}

/** 仅列出指定会话的记录（旧→新）；legacy 不混入任何会话。 */
export function listCheckpointSummaries(cwd: string, sessionId: string): CheckpointSummary[] {
  if (!isValidIdentity(sessionId)) return []
  return loadManifest(cwd).filter((record) => record.sessionId === sessionId).map(summarize)
}

/** 复用现有 LCS 算法，但先限制矩阵/文本大小，再限制 IPC 和权限预览的输出体积。 */
export function buildCheckpointFileDiff(before: string, after: string): CheckpointFileDiff {
  if (before === after) return { hunks: [], added: 0, removed: 0, truncated: false, preview: '' }
  const omitted = (reason: string): CheckpointFileDiff => ({
    hunks: [], truncated: true, preview: `… ${reason}，已省略逐行差异；请直接查看文件。 …`,
  })
  if (before.includes('\0') || after.includes('\0')) return omitted('文件包含二进制内容')
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > MAX_DIFF_INPUT_BYTES) return omitted('文件较大')
  const oldLines = before === '' ? 0 : before.split('\n').length
  const newLines = after === '' ? 0 : after.split('\n').length
  if ((oldLines + 1) * (newLines + 1) > MAX_DIFF_CELLS) return omitted('差异计算量较大')

  const full = buildDiffHunks(before, after)
  const hunks: DiffHunk[] = []
  let added = 0
  let removed = 0
  let lineBudget = MAX_DIFF_LINES
  let byteBudget = MAX_DIFF_OUTPUT_BYTES
  let truncated = false
  for (const hunk of full) {
    for (const line of hunk.lines) {
      if (line.type === 'add') added++
      if (line.type === 'del') removed++
    }
    if (truncated) continue
    const lines: DiffHunk['lines'] = []
    byteBudget -= 100 // 为 hunk 头和数字字段保留空间。
    for (const line of hunk.lines) {
      const bytes = Buffer.byteLength(JSON.stringify(line))
      if (lineBudget <= 0 || bytes > byteBudget) {
        truncated = true
        break
      }
      lines.push(line)
      lineBudget--
      byteBudget -= bytes
    }
    if (lines.length > 0) {
      hunks.push({
        oldStart: lines.find((line) => line.oldLine !== null)?.oldLine ?? 0,
        oldCount: lines.filter((line) => line.oldLine !== null).length,
        newStart: lines.find((line) => line.newLine !== null)?.newLine ?? 0,
        newCount: lines.filter((line) => line.newLine !== null).length,
        lines,
      })
    }
  }
  const view = hunks.flatMap((hunk) => [
    { type: 'hunk' as const, oldLine: null, newLine: null, text: formatHunkHeader(hunk) },
    ...hunk.lines,
  ])
  let preview = renderDiffViewText(view)
  if (truncated) preview += '\n… 差异较多，已省略后续差异；请直接查看文件。 …'
  return { hunks, added, removed, truncated, preview }
}

function requireSessionRecord(records: CheckpointRecord[], id: string, sessionId: string): CheckpointRecord {
  if (!isValidIdentity(sessionId)) throw new CheckpointError('invalid_session', '必须提供当前会话 id。')
  if (!isSafeId(id)) throw new CheckpointError('invalid_id', '检查点 id 非法。')
  const record = records.find((entry) => entry.id === id)
  if (!record) throw new CheckpointError('not_found', '未找到检查点。')
  if (!record.sessionId) throw new CheckpointError('legacy', '历史检查点没有会话身份，仅可通过 CLI /undo 回退。')
  if (record.sessionId !== sessionId) throw new CheckpointError('session_mismatch', '检查点不属于当前会话。')
  return record
}

function readSnapshot(cwd: string, record: CheckpointRecord, after: boolean): Buffer | null {
  if ((!after && record.wasNewFile) || (after && record.afterHash === null)) return null
  let content: Buffer
  try {
    content = readFileSync(getBackupPath(cwd, record.id, after))
  } catch (error) {
    if (isMissing(error)) throw new CheckpointError('snapshot_missing', `检查点${after ? '写后' : '写前'}备份丢失。`)
    throw error
  }
  const expected = after ? record.afterHash : record.beforeHash
  const bytes = after ? record.afterBytes : record.bytes
  if ((expected !== undefined && expected !== hash(content)) || (bytes !== undefined && bytes !== content.length)) {
    throw new CheckpointError('snapshot_corrupt', `检查点${after ? '写后' : '写前'}备份校验失败。`)
  }
  return content
}

/** 基于不可变的前后快照生成 diff，不把磁盘上后来的人为修改误算为本次工具改动。 */
export function getCheckpointDiff(cwd: string, id: string, sessionId: string): CheckpointDiffResult {
  try {
    if (!isSafeId(id)) throw new CheckpointError('invalid_id', '检查点 id 非法。')
    const record = requireSessionRecord(loadManifest(cwd, true), id, sessionId)
    if (record.pending || record.afterHash === undefined) throw new CheckpointError('incomplete', '检查点尚未完成写入。')
    if (!record.wasNewFile && !record.beforeHash) throw new CheckpointError('snapshot_corrupt', '检查点缺少写前 hash。')
    resolveTargetAbs(cwd, record.targetPath)
    const before = readSnapshot(cwd, record, false)
    const after = readSnapshot(cwd, record, true)
    return { ok: true, checkpoint: summarize(record), ...buildCheckpointFileDiff(before?.toString('utf8') ?? '', after?.toString('utf8') ?? '') }
  } catch (error) {
    return { ok: false, code: error instanceof CheckpointError ? error.code : 'io_error', error: errorMessage(error) }
  }
}

interface PreparedCheckpoint {
  record: CheckpointRecord
  before: Buffer | null
  after: Buffer | null
  expectedAfter: string | null
}

function emptyUndoResult(): SessionUndoResult {
  return { ok: false, restored: [], deleted: [], count: 0, errors: [], undoneIds: [], failures: [] }
}

function addFailure(result: SessionUndoResult, error: unknown, record?: Pick<CheckpointRecord, 'id' | 'targetPath'>): void {
  const message = errorMessage(error)
  result.failures.push({
    code: error instanceof CheckpointError ? error.code : 'io_error',
    message,
    ...(record ? { checkpointId: record.id, path: record.targetPath } : {}),
  })
  result.errors.push(record ? `${record.targetPath}（${record.id}）：${message}` : message)
}

/** 写临时文件后再替换，避免恢复失败把当前文件截断；替换前再次检查实时状态。 */
function restoreState(cwd: string, record: CheckpointRecord, content: Buffer | null, expectedHash: string | null): void {
  const abs = resolveTargetAbs(cwd, record.targetPath)
  if (readFileState(abs).hash !== expectedHash) {
    throw new CheckpointError('conflict', '文件在回退期间发生修改，已停止回退。')
  }
  if (content === null) {
    if (expectedHash !== null) unlinkSync(abs)
    return
  }
  mkdirSync(dirname(abs), { recursive: true })
  const temp = join(dirname(abs), `.dcode-undo-${randomBytes(8).toString('hex')}.tmp`)
  try {
    const mode = expectedHash === null ? 0o666 : lstatSync(abs).mode & 0o777
    writeFileSync(temp, content, { flag: 'wx', mode })
    const checked = resolveTargetAbs(cwd, record.targetPath)
    if (checked !== abs || readFileState(checked).hash !== expectedHash) {
      throw new CheckpointError('conflict', '文件在回退期间发生修改，已停止回退。')
    }
    renameSync(temp, abs)
  } finally {
    try { unlinkSync(temp) } catch { /* rename 成功后临时文件已不存在。 */ }
  }
}

function undoSelectedCheckpoints(cwd: string, ids: string[], sessionId?: string, allowLegacy = false): SessionUndoResult {
  const result = emptyUndoResult()
  let records: CheckpointRecord[]
  try {
    if (!allowLegacy && !isValidIdentity(sessionId)) throw new CheckpointError('invalid_session', '必须提供当前会话 id。')
    if (!Array.isArray(ids) || ids.some((id) => !isSafeId(id)) || new Set(ids).size !== ids.length) {
      throw new CheckpointError('invalid_id', '检查点 id 非法或重复。')
    }
    records = loadManifest(cwd, true)
    for (const id of ids) {
      if (!allowLegacy) requireSessionRecord(records, id, sessionId!)
      else if (!records.some((record) => record.id === id)) throw new CheckpointError('not_found', '未找到检查点。')
    }
  } catch (error) {
    addFailure(result, error)
    return result
  }

  const selected = new Set(ids)
  const virtual = new Map<string, FileState>()
  const prepared: PreparedCheckpoint[] = []
  // 同一文件连续修改时，先校验当前状态，再用各 before 快照模拟逆序回退，不能逐条与磁盘最新值比较。
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    if (!selected.has(record.id)) continue
    try {
      const key = pathKey(record.targetPath)
      if (records.slice(index + 1).some((newer) => pathKey(newer.targetPath) === key && !selected.has(newer.id))) {
        throw new CheckpointError('conflict', '同一文件存在未选中的更新检查点，不能覆盖后续改动。')
      }
      if (record.pending || (!allowLegacy && record.afterHash === undefined)) {
        throw new CheckpointError('incomplete', '检查点尚未完成写入，不能安全回退。')
      }
      const abs = resolveTargetAbs(cwd, record.targetPath)
      const before = readSnapshot(cwd, record, false)
      if (record.afterHash !== undefined) {
        if (!record.wasNewFile && !record.beforeHash) throw new CheckpointError('snapshot_corrupt', '检查点缺少写前 hash。')
        readSnapshot(cwd, record, true)
      }
      const current = virtual.get(key) ?? readFileState(abs)
      if (record.afterHash !== undefined && current.hash !== record.afterHash) {
        throw new CheckpointError('conflict', '文件内容与检查点写后状态不一致，可能已被用户或其他会话修改。')
      }
      prepared.push({ record, before, after: current.content, expectedAfter: current.hash })
      virtual.set(key, fileState(before))
    } catch (error) {
      addFailure(result, error, record)
    }
  }
  // 所有文件、备份和同文件变更链全部通过后才开始触碰文件。
  if (result.failures.length > 0) return result

  for (const item of prepared) {
    const { record } = item
    let applied = false
    try {
      if (JSON.stringify(loadManifest(cwd, true)) !== JSON.stringify(records)) {
        throw new CheckpointError('conflict', '检查点列表在回退期间发生变化，已停止回退。')
      }
      restoreState(cwd, record, item.before, item.expectedAfter)
      applied = true
      const remaining = records.filter((entry) => entry.id !== record.id)
      saveManifest(cwd, remaining)
      records = remaining
      if (record.wasNewFile) {
        if (item.expectedAfter !== null) result.deleted.push(record.targetPath)
      } else {
        result.restored.push(record.targetPath)
      }
      result.count++
      result.undoneIds.push(record.id)
      deleteBackupFiles(cwd, record.id)
    } catch (error) {
      addFailure(result, error, record)
      if (applied) {
        // manifest 提交失败时尽量恢复写后状态；补偿也必须先检查 hash，不能覆盖刚发生的人为编辑。
        try {
          restoreState(cwd, record, item.after, fileState(item.before).hash)
        } catch (recoveryError) {
          addFailure(result, new Error(`回退登记失败且无法恢复原状态，文件可能已部分回退：${errorMessage(recoveryError)}`), record)
        }
      }
      break
    }
  }
  result.ok = result.failures.length === 0
  return result
}

/** 按 id 回退当前会话的单条检查点；同文件有更新检查点时返回 conflict。 */
export function undoCheckpointById(cwd: string, id: string, sessionId: string): SessionUndoResult {
  return undoSessionCheckpoints(cwd, [id], sessionId)
}

/** 按 manifest 的逆序回退指定会话的记录；入参顺序不影响执行顺序，预检失败不会写任何文件。 */
export function undoSessionCheckpoints(cwd: string, ids: string[], sessionId: string): SessionUndoResult {
  return undoSelectedCheckpoints(cwd, ids, sessionId)
}

/** CLI 旧入口：允许无身份历史记录；具备 afterHash 的新记录仍执行冲突检查。 */
export function undoCheckpoints(cwd: string, count: number): UndoResult {
  const records = loadManifest(cwd)
  if (records.length === 0) return { restored: [], deleted: [], count: 0, errors: ['没有可回退的检查点。'] }
  const n = Math.min(Math.max(1, Number.isFinite(count) ? Math.floor(count) : 1), records.length)
  return undoSelectedCheckpoints(cwd, records.slice(-n).map((record) => record.id), undefined, true)
}

/** 清空 CLI 的全部记录；先提交 manifest，再清理文件，避免提交失败留下不可用记录。 */
export function clearCheckpoints(cwd: string): number {
  const records = loadManifest(cwd, true)
  if (records.length > 0) saveManifest(cwd, [])
  for (const record of records) deleteBackupFiles(cwd, record.id)
  return records.length
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 渲染 /checkpoints 列表，明确区分 legacy 和尚未完成的记录。 */
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
  records.forEach((record, i) => {
    const size = record.wasNewFile ? '（新建）' : `${record.bytes} B`
    const scope = record.sessionId ? ` · 会话 ${record.sessionId}` : ' · legacy（无会话身份）'
    lines.push(
      `  ${String(i + 1).padStart(3)}. [${formatTime(record.timestamp)}] ${record.targetPath}`,
      `       ${record.tool} · ${size}${scope}${record.pending ? ' · 写入未完成' : ''}`,
    )
  })
  lines.push('', '用法：/undo [N] 回退最近 N 个检查点（默认 1）', '      /checkpoints clear 清空全部备份')
  return lines.join('\n')
}

/** 渲染 CLI undo 结果。 */
export function renderUndoResult(result: UndoResult): string {
  if (result.count === 0 && result.errors.length > 0) return result.errors.join('\n')
  const parts = [`已回退 ${result.count} 个检查点。`]
  if (result.restored.length > 0) parts.push(`恢复文件：${result.restored.join('、')}`)
  if (result.deleted.length > 0) parts.push(`删除新建文件：${result.deleted.join('、')}`)
  if (result.errors.length > 0) parts.push(`警告：\n${result.errors.map((error) => `  - ${error}`).join('\n')}`)
  return parts.join('\n')
}

/** 会话结束时提示仍保留的检查点。 */
export function getCheckpointExitHint(cwd: string): string | null {
  const n = getCheckpointCount(cwd)
  return n === 0 ? null : `[检查点] 当前项目有 ${n} 个文件检查点。可用 /checkpoints 查看、/undo 回退、/checkpoints clear 清理。`
}
