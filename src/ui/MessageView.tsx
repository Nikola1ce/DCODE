// 展示项渲染组件。
// 负责把单个 DisplayItem 渲染为对应样式的终端 UI：用户消息、助手回复（含可选思维链）、
// 工具调用结果、系统提示、欢迎横幅。被 App 用于 <Static> 列表与实时区域。
// 制作人：Moriarty_Dox

import React from 'react'
import { Box, Text } from 'ink'
import type { DisplayItem, SystemTone } from './types.js'
import { useTheme, type Theme } from './theme.js'
import { Banner } from './Banner.js'
import { classifyDiffPreviewLine } from '../tools/diff.js'

// 单条展示项的入参。
interface MessageViewProps {
  // 要渲染的展示项。
  item: DisplayItem
  // 是否展示思维链（受配置控制）。
  showThinking: boolean
}

// 工具结果在历史中的最大预览行数（避免长输出刷屏）。
const TOOL_RESULT_PREVIEW_LINES = 12

/**
 * 渲染单个展示项。
 * @param props 入参。
 * @returns 对应的 JSX。
 */
export function MessageView({ item, showThinking }: MessageViewProps): React.ReactElement {
  const theme = useTheme()

  switch (item.kind) {
    case 'banner':
      // 欢迎横幅。
      return <Banner model={item.model} cwd={item.cwd} />

    case 'user':
      // 用户消息：以彩色提示符 + 文本展示。
      return (
        <Box marginBottom={1}>
          <Text color={theme.user} bold>
            {'› 你  '}
          </Text>
          <Text color={theme.text}>{item.text}</Text>
        </Box>
      )

    case 'assistant':
      // 助手回复（会话回放）：思维链折叠为一行「✻ 已思考」摘要（Claude Code 风格），不再整段铺开；
      // 随后展示正文。这样恢复历史会话时的观感与实时流式一致、不刷屏。
      return (
        <Box flexDirection="column" marginBottom={1}>
          {showThinking && item.reasoning && item.reasoning.trim() ? (
            <Box marginBottom={item.text.trim() ? 1 : 0}>
              <Text color={theme.dim} italic>
                {`✻ 已思考（${item.reasoning.trim().length} 字）`}
              </Text>
            </Box>
          ) : null}
          {item.text.trim() ? (
            <Box>
              <Text color={theme.primary} bold>
                {'● '}
              </Text>
              <Box flexDirection="column">
                <Text color={theme.text}>{item.text.trim()}</Text>
              </Box>
            </Box>
          ) : null}
        </Box>
      )

    case 'thinking':
      // 思考折叠摘要（实时流式产出）：历史区只保留一行「✻ 已思考（N 秒）」，
      // 暗色斜体，弱化存在感，既留痕又不喧宾夺主。
      return (
        <Box marginBottom={1}>
          <Text color={theme.dim} italic>
            {formatThinkingSummary(item.durationMs, item.chars)}
          </Text>
        </Box>
      )

    case 'stream': {
      // 流式分块：与实时区样式保持一致，多块上下紧贴拼成连续的一段回复。
      // 间隔块或空行：渲染为一行空白（用空格保证确实占一行）。
      if (item.spacer || item.text === '') {
        return (
          <Box>
            <Text>{' '}</Text>
          </Box>
        )
      }
      if (item.variant === 'reasoning') {
        // 思维链分块：首块带「💭 思考过程：」标签，续块仅暗色正文。
        return (
          <Box flexDirection="column">
            {item.head ? (
              <Text color={theme.dim} italic>
                {'💭 思考过程：'}
              </Text>
            ) : null}
            <Text color={theme.dim}>{item.text}</Text>
          </Box>
        )
      }
      // 正文分块：首块带「● 」项目符，续块用两空格缩进对齐到正文列。
      return (
        <Box>
          {item.head ? (
            <Text color={theme.primary} bold>
              {'● '}
            </Text>
          ) : (
            <Text>{'  '}</Text>
          )}
          <Box flexDirection="column">
            <Text color={theme.text}>{item.text}</Text>
          </Box>
        </Box>
      )
    }

    case 'tool':
      // 工具调用结果：标题行（带状态图标）+ 截断的结果预览。
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={item.status === 'error' ? theme.error : theme.tool}>
              {item.status === 'error' ? '✗ ' : '⚒ '}
            </Text>
            <Text color={theme.tool}>{item.summary}</Text>
          </Box>
          <Box marginLeft={2}>
            <Text color={item.status === 'error' ? theme.error : theme.dim}>
              {previewText(item.resultText)}
            </Text>
          </Box>
        </Box>
      )

    case 'system':
      // 系统提示：根据语气着色，带左侧竖线。
      return (
        <Box marginBottom={1} flexDirection="column">
          {item.text.split('\n').map((line, i) => (
            <Text key={i} color={toneColor(theme, item.tone)}>
              {i === 0 ? '┃ ' : '  '}
              {line}
            </Text>
          ))}
        </Box>
      )

    case 'permission':
      // 权限请求快照：标题 + 预览（diff 着色），整体落入 Static 滚动历史。
      // 决策选项不在此渲染（见 PermissionPrompt），以保持动态区低矮、避免残影。
      return (
        <Box
          flexDirection="column"
          marginBottom={1}
          borderStyle="round"
          borderColor={theme.warning}
          paddingX={1}
        >
          <Text color={theme.warning} bold>
            需要授权：{item.title}
          </Text>
          {item.preview ? (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle="single"
              borderColor={theme.dim}
              paddingX={1}
            >
              {item.preview.split('\n').map((line, i) => (
                <DiffPreviewLine key={i} line={line} theme={theme} />
              ))}
            </Box>
          ) : null}
        </Box>
      )

    default:
      return <Text> </Text>
  }
}

/**
 * 生成思考折叠摘要文案「✻ 已思考（N 秒）」。
 * 耗时不足 1 秒时显示「<1 秒」；附带可选的思考字符数，便于感知思考量。
 * @param durationMs 思考耗时（毫秒）。
 * @param chars 思考内容字符数（可选）。
 * @returns 一行摘要文本。
 */
function formatThinkingSummary(durationMs: number, chars?: number): string {
  const seconds = durationMs / 1000
  const timeText = seconds < 1 ? '<1 秒' : `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`
  const charsText = chars && chars > 0 ? `，${chars} 字` : ''
  return `✻ 已思考（${timeText}${charsText}）`
}

/**
 * 截断工具结果文本，仅保留前若干行供历史预览。
 * @param text 完整结果文本。
 * @returns 截断后的预览文本。
 */
function previewText(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= TOOL_RESULT_PREVIEW_LINES) return text
  const shown = lines.slice(0, TOOL_RESULT_PREVIEW_LINES).join('\n')
  return `${shown}\n… 省略 ${lines.length - TOOL_RESULT_PREVIEW_LINES} 行 …`
}

// 单行 diff 预览的入参。
interface DiffPreviewLineProps {
  // 该行的预览文本（来自 buildDiffPreviewView，含行号列与 +/- 标记或 @@ 头）。
  line: string
  // 当前主题。
  theme: Theme
}

/**
 * 渲染一行增强 diff 预览：
 *   - hunk 头（@@ ... @@ / 省略提示）：accent 色，作为分段标识；
 *   - 新增行：success 前景；删除行：error 前景；并对变更行加粗以增强对比；
 *   - 上下文行：dim 前景。
 * 行号列已包含在文本中（renderDiffViewText 生成），无需额外绘制。
 * @param props 入参。
 * @returns 单行 JSX。
 */
function DiffPreviewLine({ line, theme }: DiffPreviewLineProps): React.ReactElement {
  const kind = classifyDiffPreviewLine(line)
  // 空行仍占一行高度，避免 diff 中的空行被折叠。
  const text = line === '' ? ' ' : line
  if (kind === 'hunk') {
    return (
      <Text color={theme.accent} bold>
        {text}
      </Text>
    )
  }
  if (kind === 'add') {
    return (
      <Text color={theme.success} bold>
        {text}
      </Text>
    )
  }
  if (kind === 'del') {
    return (
      <Text color={theme.error} bold>
        {text}
      </Text>
    )
  }
  return <Text color={theme.dim}>{text}</Text>
}

/**
 * 根据系统提示语气返回颜色。
 * @param theme 当前主题。
 * @param tone 语气。
 * @returns 颜色值。
 */
function toneColor(theme: Theme, tone: SystemTone): string {
  switch (tone) {
    case 'success':
      return theme.success
    case 'error':
      return theme.error
    case 'warning':
      return theme.warning
    default:
      return theme.dim
  }
}
