// 工具实时进度文本处理：控制动态区刷新量，并移除会扰动终端光标的控制序列。

const ANSI_ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g
const UNSAFE_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

/**
 * 清洗工具进度文本。
 * - 去掉 ANSI 控制序列，避免子进程输出影响 TUI 光标/颜色；
 * - 把进度条常用的 \r 统一成换行，交给尾部截断逻辑只展示最近几行。
 */
export function normalizeToolProgressText(text: string): string {
  return text
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(UNSAFE_CONTROL_RE, '')
}

/**
 * 追加并截断工具进度，保证动态区只保留最近一小段。
 */
export function appendToolProgress(
  previous: string,
  incoming: string,
  maxChars = 400,
): string {
  const normalized = normalizeToolProgressText(incoming)
  if (!normalized) return previous
  return (previous + normalized).slice(-Math.max(1, maxChars))
}
