// 文件编辑工具（edit_file）。
// 通过“精确字符串替换”的方式局部修改文件，避免整体重写带来的风险。
// 约束：old_string 必须在文件中唯一出现（除非 replace_all=true），否则报错并提示补充上下文。
// 属于写操作，权限策略与 write_file 相同。
// 制作人：Moriarty_Dox

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { saveCheckpointBeforeWrite } from '../core/checkpoint.js'
import type { PermissionRequest, ToolDefinition, ToolResult } from '../core/types.js'
import { buildDiffPreview, countDiff } from './diff.js'
import { resolveWithinCwd, toDisplayPath } from './util.js'

// edit_file 的入参结构。
interface EditFileInput {
  // 目标文件路径。
  path: string
  // 要被替换的原始字符串（需与文件内容精确匹配，含缩进与换行）。
  old_string: string
  // 替换后的新字符串。
  new_string: string
  // 是否替换全部匹配项（默认 false，仅替换唯一匹配）。
  replace_all?: boolean
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    '对已有文件进行精确字符串替换式编辑。old_string 必须与文件中的内容逐字符匹配（包含缩进、换行）。' +
    '默认要求 old_string 在文件中唯一；如需替换所有匹配项，请设置 replace_all=true。' +
    '相比 write_file，此工具更适合局部修改，能显著降低误改风险。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对当前工作目录或绝对路径' },
      old_string: { type: 'string', description: '要被替换的原始文本（需精确匹配）' },
      new_string: { type: 'string', description: '替换后的新文本' },
      replace_all: {
        type: 'boolean',
        description: '是否替换所有匹配项，默认 false（仅替换唯一匹配）',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  renderCall: (input: EditFileInput) => `编辑 ${input.path}`,
  /**
   * 权限检查：编辑文件默认需要授权，并附带 diff 预览。
   */
  checkPermission: (input: EditFileInput, ctx): PermissionRequest | null => {
    if (ctx.permissionMode === 'acceptEdits' || ctx.permissionMode === 'bypass') {
      return null
    }
    const abs = resolveWithinCwd(ctx.cwd, input.path)
    // 预先计算替换后的文本以生成 diff（失败则不附预览）。
    let preview: string | undefined
    try {
      const oldContent = readFileSync(abs, 'utf8')
      const newContent = applyEdit(oldContent, input)
      preview = buildDiffPreview(oldContent, newContent)
    } catch {
      preview = undefined
    }
    return {
      toolName: 'edit_file',
      title: `编辑文件 ${toDisplayPath(ctx.cwd, abs)}`,
      preview,
      ruleKey: `edit_file(${input.path})`,
    }
  },
  /**
   * 执行编辑：读取文件、做唯一性校验、替换并写回。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果。
   */
  run: async (input: EditFileInput, ctx): Promise<ToolResult> => {
    const abs = resolveWithinCwd(ctx.cwd, input.path)
    if (!existsSync(abs)) {
      return { llmContent: `错误：文件不存在 ${input.path}`, isError: true }
    }
    const oldContent = readFileSync(abs, 'utf8')

    // old_string 与 new_string 相同则属于无效编辑。
    if (input.old_string === input.new_string) {
      return {
        llmContent: '错误：old_string 与 new_string 相同，没有可应用的修改。',
        isError: true,
      }
    }

    // 校验匹配次数。
    const occurrences = countOccurrences(oldContent, input.old_string)
    if (occurrences === 0) {
      return {
        llmContent:
          '错误：在文件中未找到 old_string。请先用 read_file 确认确切内容（注意缩进与空白）。',
        isError: true,
      }
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        llmContent: `错误：old_string 在文件中出现了 ${occurrences} 次，不唯一。请补充更多上下文使其唯一，或设置 replace_all=true。`,
        isError: true,
      }
    }

    const newContent = applyEdit(oldContent, input)

    // 写入前创建检查点，供 /undo 回退。
    saveCheckpointBeforeWrite(ctx.cwd, abs, 'edit_file')

    writeFileSync(abs, newContent, 'utf8')

    const { added, removed } = countDiff(oldContent, newContent)
    return {
      llmContent: `已编辑 ${input.path}（新增 ${added} 行，删除 ${removed} 行）。`,
      uiSummary: `编辑 ${toDisplayPath(ctx.cwd, abs)}  +${added} -${removed}`,
    }
  },
}

/**
 * 统计子串在文本中出现的次数（非重叠）。
 * @param text 源文本。
 * @param sub 子串。
 * @returns 出现次数。
 */
function countOccurrences(text: string, sub: string): number {
  if (sub === '') return 0
  let count = 0
  let idx = text.indexOf(sub)
  while (idx !== -1) {
    count++
    idx = text.indexOf(sub, idx + sub.length)
  }
  return count
}

/**
 * 应用替换逻辑，返回替换后的新文本。
 * @param content 原始文件内容。
 * @param input 编辑入参。
 * @returns 替换后的内容。
 */
function applyEdit(content: string, input: EditFileInput): string {
  if (input.replace_all) {
    // 使用 split/join 实现安全的全量替换（避免正则特殊字符问题）。
    return content.split(input.old_string).join(input.new_string)
  }
  // 仅替换首个匹配（调用方已保证唯一性）。
  const idx = content.indexOf(input.old_string)
  if (idx === -1) return content
  return (
    content.slice(0, idx) +
    input.new_string +
    content.slice(idx + input.old_string.length)
  )
}
