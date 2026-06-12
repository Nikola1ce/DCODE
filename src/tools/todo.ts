// 待办管理工具（todo_write）。
// 让模型在执行多步骤任务时维护一份结构化任务清单，UI 据此渲染任务进度。
// 属于“写状态但不触碰磁盘/系统”的轻量工具，无需用户授权。
// 设计借鉴 Claude Code 的 TodoWrite：整份替换式更新，强调“同一时刻仅一项 in_progress”。
// 制作人：Moriarty_Dox

import type { TodoItem, TodoStatus, ToolDefinition, ToolResult } from '../core/types.js'

// todo_write 的入参结构。
interface TodoWriteInput {
  // 完整的任务列表（整份替换现有列表）。
  todos: { content: string; status: TodoStatus }[]
}

export const todoWriteTool: ToolDefinition = {
  name: 'todo_write',
  description:
    '创建/更新结构化任务清单，用于规划与跟踪多步骤任务。每次调用都用新列表整体替换旧列表。' +
    '状态取值：pending（未开始）、in_progress（进行中）、completed（已完成）。' +
    '建议同一时刻仅保留一个 in_progress 任务；完成一项后及时标记 completed。' +
    '适合三步以上的复杂任务；简单任务无需使用。',
  readOnly: true,
  safety: { sideEffect: 'state', parallelSafe: false },
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '任务列表',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '任务描述' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: '任务状态',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  renderCall: () => '更新任务清单',
  /**
   * 执行更新：写入共享待办状态，并返回当前进度摘要。
   * @param input 入参。
   * @param ctx 运行上下文（提供 setTodos 回调）。
   * @returns 工具结果。
   */
  run: async (input: TodoWriteInput, ctx): Promise<ToolResult> => {
    const todos: TodoItem[] = (input.todos ?? []).map((t) => ({
      content: t.content,
      status: t.status,
    }))
    // 写入共享状态，UI 会据此重新渲染任务面板。
    ctx.setTodos(todos)

    const done = todos.filter((t) => t.status === 'completed').length
    const total = todos.length
    // 用清单文本回传给模型，帮助其确认状态已记录。
    const list = todos
      .map((t) => {
        const mark =
          t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'
        return `${mark} ${t.content}`
      })
      .join('\n')
    return {
      llmContent: `任务清单已更新（${done}/${total} 完成）：\n${list}`,
      uiSummary: `任务清单更新（${done}/${total}）`,
    }
  },
}
