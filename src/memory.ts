// 项目记忆模块（DCODE.md）。
// 借鉴 Claude Code 的 CLAUDE.md 机制：在工作目录与用户主目录读取 DCODE.md，
// 将其内容注入系统提示，让助手记住项目约定、技术栈、命令、风格偏好等长期上下文。
// 制作人：Moriarty_Dox

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_FILE_NAME } from './constants.js'
import { getConfigDir } from './config.js'

// 一条已加载的记忆来源（用于在系统提示中标注出处）。
export interface MemoryEntry {
  // 记忆来源标签：项目级 / 全局级。
  scope: 'project' | 'global'
  // 文件绝对路径。
  path: string
  // 文件文本内容。
  content: string
}

/**
 * 加载所有可用的记忆文件。
 * 顺序：先全局（~/.dcode/DCODE.md），后项目（<cwd>/DCODE.md）；
 * 项目级排后面，便于在提示中“后者优先”，覆盖全局偏好。
 * @param cwd 当前工作目录。
 * @returns 记忆条目数组（可能为空）。
 */
export function loadMemories(cwd: string): MemoryEntry[] {
  const entries: MemoryEntry[] = []

  // 全局记忆：跨项目通用的个人偏好。
  const globalPath = join(getConfigDir(), MEMORY_FILE_NAME)
  if (existsSync(globalPath)) {
    try {
      entries.push({
        scope: 'global',
        path: globalPath,
        content: readFileSync(globalPath, 'utf8'),
      })
    } catch {
      // 读取失败忽略。
    }
  }

  // 项目记忆：当前仓库的专属约定。
  const projectPath = join(cwd, MEMORY_FILE_NAME)
  if (existsSync(projectPath)) {
    try {
      entries.push({
        scope: 'project',
        path: projectPath,
        content: readFileSync(projectPath, 'utf8'),
      })
    } catch {
      // 读取失败忽略。
    }
  }

  return entries
}

/**
 * 将记忆条目拼装为可注入系统提示的文本块。
 * @param entries loadMemories 的结果。
 * @returns 拼装后的文本；无记忆时返回空串。
 */
export function formatMemories(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ''
  const blocks = entries.map((e) => {
    const label = e.scope === 'global' ? '全局记忆' : '项目记忆'
    return `# ${label}（来源：${e.path}）\n${e.content.trim()}`
  })
  return blocks.join('\n\n')
}

/**
 * 判断当前工作目录是否已存在项目级 DCODE.md。
 * 供 /init 命令决定是新建还是覆盖。
 * @param cwd 当前工作目录。
 * @returns 存在返回 true。
 */
export function hasProjectMemory(cwd: string): boolean {
  return existsSync(join(cwd, MEMORY_FILE_NAME))
}

/**
 * 计算项目级记忆文件的绝对路径。
 * @param cwd 当前工作目录。
 * @returns DCODE.md 绝对路径。
 */
export function getProjectMemoryPath(cwd: string): string {
  return join(cwd, MEMORY_FILE_NAME)
}
