// Skills 技能包管理。
// 从 ~/.dcode/skills/ 与项目 .dcode/skills/ 加载 Markdown 技能文件（YAML frontmatter + 正文），
// 供 /skill 命令列出、加载到会话 system 提示，或通过 Agent 从对话摘要创建新技能。
// 项目级同名技能覆盖全局；首次启动时写入内置模板到用户目录。
// 制作人：Moriarty_Dox

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureConfigDir, getConfigDir } from '../config.js'
import { CONFIG_DIR_NAME } from '../constants.js'

/** 技能作用域：全局 ~/.dcode/skills 或项目 .dcode/skills。 */
export type SkillScope = 'global' | 'project'

/** 解析后的技能元数据与正文。 */
export interface SkillDefinition {
  /** 技能唯一名（frontmatter name 或文件名）。 */
  name: string
  /** 简短说明，供 /skill list 展示。 */
  description: string
  /** Markdown 正文（不含 frontmatter）。 */
  body: string
  /** 来源路径。 */
  path: string
  /** 作用域。 */
  scope: SkillScope
}

/** 列表展示用的轻量结构。 */
export interface SkillSummary {
  name: string
  description: string
  scope: SkillScope
  path: string
}

/** 内置技能模板（首次启动写入 ~/.dcode/skills/）。 */
const BUILTIN_SKILLS: Array<{ name: string; description: string; body: string }> = [
  {
    name: 'unit-test',
    description: '为现有代码生成单元测试（Vitest/Jest 等）',
    body: `# 生成单元测试

当用户要求为代码编写测试时：

1. 先 read_file 阅读被测模块与项目测试配置（package.json、vitest.config 等）。
2. 匹配项目已有测试风格（describe/it、mock 方式、断言库）。
3. 覆盖：正常路径、边界条件、关键错误路径；避免只测实现细节。
4. 测试文件命名与目录遵循项目惯例（如 \`*.test.ts\` 与源文件同目录或 __tests__）。
5. 运行 \`npm test\` 或项目等价命令验证通过后再汇报。`,
  },
  {
    name: 'refactor',
    description: '安全、小步代码重构与结构优化',
    body: `# 代码重构

当用户要求重构时：

1. 先 grep/read_file 理解调用关系与测试覆盖。
2. 每次改动保持行为等价；优先小步提交式修改，避免大爆炸重写。
3. 保留公共 API 与存储格式兼容；不引入无关抽象。
4. 重构后运行现有测试或 lint/typecheck。
5. 向用户说明：改了什么、为什么、剩余风险。`,
  },
  {
    name: 'api-docs',
    description: '为 API/模块生成 Markdown 文档',
    body: `# API 文档生成

当用户要求写 API 文档时：

1. 阅读源码、类型定义与现有 README/注释。
2. 输出 Markdown：概述、安装/导入、参数表、返回值、错误码、示例请求。
3. 公开函数/类均文档化；内部私有符号可省略。
4. 示例代码须可运行且与当前 API 一致。
5. 使用简体中文，术语与代码标识保持英文。`,
  },
  {
    name: 'code-review',
    description: '结构化代码审查（缺陷、安全、可读性）',
    body: `# 代码审查

当用户要求 review 代码时：

1. 阅读 diff 或指定文件，按严重度分级：Critical / High / Medium / Low。
2. 每条发现含：位置、问题、建议修复；无问题时明确说明。
3. 关注：逻辑错误、边界/空值、安全（注入、密钥泄露）、性能明显问题。
4. 不臆测未读代码；不强制无关风格争论。
5. 输出简洁表格或列表，便于用户逐条处理。`,
  },
  {
    name: 'debug',
    description: '系统化调试与根因分析',
    body: `# 系统化调试

当用户报告 bug 或异常行为时：

1. 复现步骤与期望/实际行为写清楚。
2. 收集证据：日志、堆栈、相关 read_file/grep；不要未验证就改代码。
3. 形成假设 → 最小验证 → 确认根因后再修复。
4. 修复尽量小；补充回归测试（若项目有测试套件）。
5. 说明根因、修复方式与如何防止复发。`,
  },
]

/**
 * 全局 skills 目录（~/.dcode/skills/）。
 * @returns 绝对路径。
 */
export function getGlobalSkillsDir(): string {
  return join(getConfigDir(), 'skills')
}

/**
 * 项目 skills 目录（<cwd>/.dcode/skills/）。
 * @param cwd 工作目录。
 * @returns 绝对路径。
 */
export function getProjectSkillsDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, 'skills')
}

/**
 * 校验技能名是否合法（字母数字、下划线、连字符）。
 * @param name 技能名。
 * @returns 合法返回 true。
 */
export function isValidSkillName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0 && name.length <= 64
}

/**
 * 确保内置技能模板已写入 ~/.dcode/skills/（不存在时才写，不覆盖用户文件）。
 */
export function ensureBuiltinSkills(): void {
  ensureConfigDir()
  const dir = getGlobalSkillsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  for (const tpl of BUILTIN_SKILLS) {
    const path = join(dir, `${tpl.name}.md`)
    if (existsSync(path)) continue
    writeFileSync(path, formatSkillFile(tpl.name, tpl.description, tpl.body), 'utf8')
  }
}

/**
 * 列出可用技能（项目覆盖全局同名）。
 * @param cwd 工作目录。
 * @returns 按名称排序的摘要列表。
 */
export function listAvailableSkills(cwd: string): SkillSummary[] {
  const map = new Map<string, SkillSummary>()

  const scanDir = (dir: string, scope: SkillScope) => {
    if (!existsSync(dir)) return
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.SKILL.md'))
    } catch {
      return
    }
    for (const file of files) {
      const path = join(dir, file)
      try {
        const raw = readFileSync(path, 'utf8')
        const skill = parseSkillFile(raw, path, scope)
        map.set(skill.name, {
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          path: skill.path,
        })
      } catch {
        // 损坏文件跳过。
      }
    }
  }

  scanDir(getGlobalSkillsDir(), 'global')
  scanDir(getProjectSkillsDir(cwd), 'project')

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 按名称加载技能（项目优先于全局）。
 * @param name 技能名。
 * @param cwd 工作目录。
 * @returns 技能定义；未找到返回 null。
 */
export function loadSkillByName(name: string, cwd: string): SkillDefinition | null {
  const projectPath = join(getProjectSkillsDir(cwd), `${name}.md`)
  if (existsSync(projectPath)) {
    try {
      return parseSkillFile(readFileSync(projectPath, 'utf8'), projectPath, 'project')
    } catch {
      return null
    }
  }
  const globalPath = join(getGlobalSkillsDir(), `${name}.md`)
  if (existsSync(globalPath)) {
    try {
      return parseSkillFile(readFileSync(globalPath, 'utf8'), globalPath, 'global')
    } catch {
      return null
    }
  }
  return null
}

/**
 * 解析技能 Markdown 文件（YAML frontmatter + 正文）。
 * @param raw 文件全文。
 * @param path 文件路径。
 * @param scope 作用域。
 * @returns 技能定义。
 */
export function parseSkillFile(raw: string, path: string, scope: SkillScope): SkillDefinition {
  const { frontmatter, body } = splitFrontmatter(raw)
  const nameFromFm = frontmatter.name?.trim()
  const descFromFm = frontmatter.description?.trim()
  const baseName = path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') ?? 'unknown'
  const name = nameFromFm || baseName
  const description = descFromFm || '（无描述）'
  return {
    name,
    description,
    body: body.trim(),
    path,
    scope,
  }
}

/**
 * 将已加载技能格式化为 system 提示段落。
 * @param skills 当前会话激活的技能。
 * @returns Markdown 文本；无技能时返回空串。
 */
export function formatSkillsForPrompt(skills: SkillDefinition[]): string {
  if (skills.length === 0) return ''
  const blocks = skills.map(
    (s) =>
      `## 技能：${s.name}\n` +
      `（${s.description}；来源：${s.scope === 'project' ? '项目' : '全局'} ${s.path}）\n\n` +
      s.body,
  )
  return blocks.join('\n\n---\n\n')
}

/**
 * 写入新技能文件。
 * @param name 技能名。
 * @param description 描述。
 * @param body Markdown 正文。
 * @param cwd 工作目录。
 * @param scope 写入全局或项目目录。
 * @returns 写入的绝对路径。
 */
export function writeSkillFile(
  name: string,
  description: string,
  body: string,
  cwd: string,
  scope: SkillScope = 'project',
): string {
  if (!isValidSkillName(name)) {
    throw new Error(`无效的技能名：${name}（仅允许字母、数字、_、-）`)
  }
  const dir = scope === 'project' ? getProjectSkillsDir(cwd) : getGlobalSkillsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.md`)
  writeFileSync(path, formatSkillFile(name, description, body), 'utf8')
  return path
}

/**
 * 生成完整技能 Markdown 文件内容。
 * @param name 技能名。
 * @param description 描述。
 * @param body 正文。
 * @returns 文件全文。
 */
export function formatSkillFile(name: string, description: string, body: string): string {
  return `---
name: ${name}
description: ${description}
---

${body.trim()}
`
}

/**
 * 渲染 /skill list 文本。
 * @param cwd 工作目录。
 * @param activeNames 当前会话已加载的技能名。
 * @returns 多行文本。
 */
export function renderSkillList(cwd: string, activeNames: string[] = []): string {
  const skills = listAvailableSkills(cwd)
  const activeSet = new Set(activeNames)
  if (skills.length === 0) {
    return [
      '（暂无技能文件）',
      '',
      `全局目录：${getGlobalSkillsDir()}`,
      `项目目录：${getProjectSkillsDir(cwd)}`,
      '',
      '用法：/skills 查看列表 | /skill <名称> 加载 | /skill create <名称> 从对话创建',
    ].join('\n')
  }
  const lines = ['可用技能：']
  for (const s of skills) {
    const tag = s.scope === 'project' ? '[项目]' : '[全局]'
    const active = activeSet.has(s.name) ? ' ✓已加载' : ''
    lines.push(`  ${tag} ${s.name.padEnd(16)} ${s.description}${active}`)
  }
  lines.push('')
  lines.push('用法：/skills 查看列表 | /skill <名称> 加载到当前会话 | /skill unload <名称> 卸载')
  lines.push('      /skill create <名称> 从当前对话摘要创建技能')
  lines.push(`目录：${getProjectSkillsDir(cwd)}（项目） / ${getGlobalSkillsDir()}（全局）`)
  return lines.join('\n')
}

/**
 * 拆分 YAML frontmatter 与正文（简单 key: value 解析，不依赖 yaml 库）。
 * @param raw 文件全文。
 * @returns frontmatter 键值对与正文。
 */
function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string>
  body: string
} {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: raw }
  }
  const end = trimmed.indexOf('---', 3)
  if (end === -1) {
    return { frontmatter: {}, body: raw }
  }
  const fmBlock = trimmed.slice(3, end).trim()
  const body = trimmed.slice(end + 3).trimStart()
  const frontmatter: Record<string, string> = {}
  for (const line of fmBlock.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) frontmatter[key] = value
  }
  return { frontmatter, body }
}
