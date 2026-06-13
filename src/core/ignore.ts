// 忽略规则统一模块（.gitignore + .dcodeignore）。
// 为文件检索类工具（glob / grep / list_dir）提供一致的「该路径是否应被忽略」判断，
// 使用户能用项目根下的 .dcodeignore（格式同 .gitignore）自定义忽略规则。
//
// 规则合并与优先级（后者覆盖前者）：
//   1) 内置默认忽略目录（DEFAULT_IGNORED_DIRS，如 node_modules/.git/dist）——始终生效；
//   2) 项目根 .gitignore；
//   3) 项目根 .dcodeignore。
// 由于 .dcodeignore 在最后加入，且 ignore 库遵循「后一条规则可覆盖前一条」的语义，
// 因此 .dcodeignore 既能新增忽略，也能用 `!pattern` 对 .gitignore 或默认规则做「反忽略」。
//
// 性能：按「根目录 + 两个忽略文件的 mtime/大小」做缓存，文件未变更时复用同一 matcher，
// 避免在大仓库里每次工具调用都重复读盘与解析。
// 制作人：Moriarty_Dox

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import {
  DCODE_IGNORE_FILE_NAME,
  DEFAULT_IGNORED_DIRS,
} from '../constants.js'

// 统一的忽略过滤器：对外只暴露「判断」与「fast-glob 模式」两类能力。
export interface IgnoreFilter {
  /**
   * 判断某个相对工作根的路径是否应被忽略。
   * @param relPathToRoot 相对 rootCwd 的路径（使用 / 或平台分隔符均可，内部会规整）。
   * @param isDir 该路径是否为目录（影响仅匹配目录的规则，如 "build/"）。
   * @returns 应忽略返回 true。
   */
  ignores(relPathToRoot: string, isDir?: boolean): boolean
  /**
   * 返回供 fast-glob `ignore` 选项使用的 glob 模式（仅含默认噪声目录）。
   * 说明：.gitignore/.dcodeignore 的完整语义（否定、锚定等）难以无损转为 glob，
   * 故 glob 阶段只用这些默认模式做粗过滤，精确过滤交由 ignores() 二次完成。
   * @returns glob 忽略模式数组。
   */
  globIgnorePatterns(): string[]
}

// 单条缓存项：记录构建依据的指纹，指纹变化即失效重建。
interface CacheEntry {
  fingerprint: string
  ig: Ignore
}

// 以 rootCwd 为键的进程级缓存。
const cache = new Map<string, CacheEntry>()

/**
 * 计算某个文件的「mtime:size」指纹（不存在则返回固定串），用于缓存失效判断。
 * @param path 文件绝对路径。
 * @returns 指纹字符串。
 */
function fileFingerprint(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'none'
  }
}

/**
 * 安全读取文本文件内容，失败返回空串（缺失或无权限时容错）。
 * @param path 文件绝对路径。
 * @returns 文件内容或空串。
 */
function safeRead(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

/**
 * 构建（或从缓存取）某工作根对应的底层 ignore matcher。
 * 合并顺序：默认目录规则 -> .gitignore -> .dcodeignore（后者可覆盖前者）。
 * @param rootCwd 工作目录根（绝对路径）。
 * @returns ignore 库的 matcher 实例。
 */
function buildMatcher(rootCwd: string): Ignore {
  const gitignorePath = join(rootCwd, '.gitignore')
  const dcodeignorePath = join(rootCwd, DCODE_IGNORE_FILE_NAME)
  // 指纹包含两个忽略文件的状态，任一变更则重建。
  const fingerprint = `${fileFingerprint(gitignorePath)}|${fileFingerprint(dcodeignorePath)}`

  const cached = cache.get(rootCwd)
  if (cached && cached.fingerprint === fingerprint) {
    return cached.ig
  }

  const ig = ignore()
  // 1) 默认噪声目录：用 "dir/" 形式同时匹配目录及其内容。
  ig.add(DEFAULT_IGNORED_DIRS.map((d) => `${d}/`))
  // 2) .gitignore。
  const gitignore = safeRead(gitignorePath)
  if (gitignore) ig.add(gitignore)
  // 3) .dcodeignore（最后加入，优先级最高，可用 ! 反忽略）。
  const dcodeignore = safeRead(dcodeignorePath)
  if (dcodeignore) ig.add(dcodeignore)

  cache.set(rootCwd, { fingerprint, ig })
  return ig
}

/**
 * 将任意路径规整为「相对 rootCwd、使用 / 分隔、无前导 ./」的形式。
 * 既接受相对 rootCwd 的路径，也接受 rootCwd 子树内的绝对路径。
 * @param rootCwd 工作目录根（绝对路径）。
 * @param p 待规整路径。
 * @returns 规整后的相对路径；若落在 rootCwd 之外则返回 null（表示不适用忽略规则）。
 */
function toRelPosix(rootCwd: string, p: string): string | null {
  const rel = isAbsolute(p) ? relative(rootCwd, p) : p
  if (rel === '' ) return null
  if (rel.startsWith('..')) return null
  // 统一分隔符为 /，并去掉可能的前导 ./。
  const posix = rel.split(sep).join('/').replace(/^\.\//, '')
  return posix.length > 0 ? posix : null
}

/**
 * 创建某工作根的统一忽略过滤器。
 * @param rootCwd 工作目录根（绝对路径，通常为 ctx.cwd）。
 * @returns 忽略过滤器。
 */
export function createIgnoreFilter(rootCwd: string): IgnoreFilter {
  const ig = buildMatcher(rootCwd)
  return {
    ignores(relPathToRoot: string, isDir = false): boolean {
      const rel = toRelPosix(rootCwd, relPathToRoot)
      // 落在工作根之外或就是根本身：不应用忽略（交由调用方的授权边界处理）。
      if (rel === null) return false
      // 对目录补一个结尾 /，确保仅匹配目录的规则（如 "build/"）能命中。
      const candidate = isDir && !rel.endsWith('/') ? `${rel}/` : rel
      try {
        return ig.ignores(candidate)
      } catch {
        return false
      }
    },
    globIgnorePatterns(): string[] {
      // 仅返回默认噪声目录的 glob 模式，供 fast-glob 做快速粗过滤。
      return DEFAULT_IGNORED_DIRS.map((d) => `**/${d}/**`)
    },
  }
}

/**
 * 便捷判断：相对 rootCwd 的路径是否被忽略（一次性场景，内部复用缓存）。
 * @param rootCwd 工作目录根。
 * @param relPathToRoot 相对根的路径。
 * @param isDir 是否为目录。
 * @returns 应忽略返回 true。
 */
export function isIgnored(
  rootCwd: string,
  relPathToRoot: string,
  isDir = false,
): boolean {
  return createIgnoreFilter(rootCwd).ignores(relPathToRoot, isDir)
}

/**
 * 清空忽略规则缓存（主要供测试使用，确保不同临时目录之间互不影响）。
 */
export function clearIgnoreCache(): void {
  cache.clear()
}
