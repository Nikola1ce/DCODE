// 流式 SSE content 增量归一化。
// 部分 OpenAI 兼容 Provider 会下发累积全文或重复 chunk，直接 append 会导致回答重复；
// 本模块统一转为真实增量，并在流结束后做 obvious 复读兜底。
// 制作人：Moriarty_Dox

/**
 * 将 SSE chunk 的 content 转为真实增量，并维护累积全文。
 * @param accumulated 当前已累积的全文。
 * @param incoming 本 chunk 的 content（delta 或 message.content）。
 * @returns next 为更新后的全文；delta 为本 chunk 应对外 yield 的增量（空串表示跳过）。
 */
export function applyStreamContentDelta(
  accumulated: string,
  incoming: string,
): { next: string; delta: string } {
  if (!incoming) {
    return { next: accumulated, delta: '' }
  }

  // 累积模式：incoming 为「至今全文」。
  if (accumulated.length > 0 && incoming.startsWith(accumulated)) {
    const delta = incoming.slice(accumulated.length)
    return { next: incoming, delta }
  }

  // 重复 chunk：与已累积尾部完全相同。
  if (
    accumulated.length >= incoming.length &&
    accumulated.endsWith(incoming) &&
    incoming.length > 0
  ) {
    return { next: accumulated, delta: '' }
  }

  // 当前行短前缀重放：列表编号等结构化前缀常会先以很短 chunk 到达，
  // 下一块又从同一行开头累计重发，例如「3.」之后收到「3. **任务规划**...」。
  const lineReplayOverlap = findStructuredLineReplayOverlap(accumulated, incoming)
  if (lineReplayOverlap > 0) {
    const delta = incoming.slice(lineReplayOverlap)
    return { next: accumulated + delta, delta }
  }

  // 当前段落重放：有些 provider 会把当前段落从段首重发并扩展，
  // 且可能把空格变成换行。若 incoming 从头能覆盖当前段落已输出内容，
  // 只追加 incoming 中尚未输出的新尾部。
  const blockReplayOverlap = findCurrentBlockReplayOverlap(accumulated, incoming)
  if (blockReplayOverlap > 0) {
    const delta = incoming.slice(blockReplayOverlap)
    return { next: accumulated + delta, delta }
  }

  // 局部累计模式：部分 OpenAI 兼容服务会在流式时反复发送“当前段落至今全文”，
  // 例如先发「2. 解析输入：接下来」，下一块又发「2. 解析输入：接下来我会...」。
  // 这既不是整条 assistant 消息的累计全文，也不是完全重复 chunk；直接 append 会把段落刷很多遍。
  const overlap = findSignificantSuffixPrefixOverlap(accumulated, incoming)
  if (overlap > 0) {
    const delta = incoming.slice(overlap)
    return { next: accumulated + delta, delta }
  }

  // 标准增量模式。
  return { next: accumulated + incoming, delta: incoming }
}

function findCurrentBlockReplayOverlap(
  accumulated: string,
  incoming: string,
): number {
  const block = getCurrentBlock(accumulated)
  if (block.length < 24 || incoming.length <= block.length) return 0
  return matchPrefixIgnoringWhitespaceRuns(block, incoming)
}

function getCurrentBlock(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const blank = normalized.lastIndexOf('\n\n')
  if (blank >= 0) return normalized.slice(blank + 2)
  const line = normalized.lastIndexOf('\n')
  return line >= 0 ? normalized.slice(line + 1) : normalized
}

function matchPrefixIgnoringWhitespaceRuns(
  expectedPrefix: string,
  incoming: string,
): number {
  let i = 0
  let j = 0
  let matchedNonWhitespace = 0

  while (i < expectedPrefix.length) {
    const a = expectedPrefix[i]
    if (isWhitespace(a)) {
      while (i < expectedPrefix.length && isWhitespace(expectedPrefix[i])) i++
      if (j >= incoming.length || !isWhitespace(incoming[j])) return 0
      while (j < incoming.length && isWhitespace(incoming[j])) j++
      continue
    }

    if (j >= incoming.length || incoming[j] !== a) return 0
    i++
    j++
    matchedNonWhitespace++
  }

  return matchedNonWhitespace >= 16 && j < incoming.length ? j : 0
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'
}

function findStructuredLineReplayOverlap(
  accumulated: string,
  incoming: string,
): number {
  const lineStart = Math.max(accumulated.lastIndexOf('\n'), accumulated.lastIndexOf('\r')) + 1
  const tail = accumulated.slice(lineStart)
  if (tail.length < 2 || tail.length > incoming.length) return 0
  if (!incoming.startsWith(tail)) return 0

  const trimmed = tail.trimStart()
  const isStructuredPrefix =
    /^\d+[.)](?:\s*)/.test(trimmed) ||
    /^[-*+](?:\s*)/.test(trimmed) ||
    /^#{1,6}(?:\s*)/.test(trimmed)
  if (!isStructuredPrefix) return 0

  return tail.length
}

/**
 * 查找 accumulated 尾部与 incoming 头部的显著重叠长度。
 * 只认较长重叠，避免把普通增量边界处偶然相同的 1-2 个字符误删。
 */
function findSignificantSuffixPrefixOverlap(
  accumulated: string,
  incoming: string,
): number {
  const max = Math.min(accumulated.length, incoming.length, 4000)
  const min = Math.min(24, Math.max(8, Math.floor(incoming.length * 0.35)))
  if (max < min) return 0

  for (let len = max; len >= min; len--) {
    if (accumulated.endsWith(incoming.slice(0, len))) {
      return len
    }
  }
  return 0
}

/**
 * 对流结束后的全文做 obvious 复读去重（连续相同分句或整段周期重复）。
 * @param text 流式累积的原始全文。
 * @returns 去重后的文本。
 */
export function collapseObviousRepetition(text: string): string {
  if (!text) return text

  // 1) 连续相同「句号/问号/叹号」分句去重（短文本也适用）。
  const parts = text.split(/(?<=[。！？])/)
  const deduped: string[] = []
  let prevTrimmed = ''
  let skippedDuplicateSentence = false
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed && trimmed === prevTrimmed) {
      skippedDuplicateSentence = true
      continue
    }
    deduped.push(part)
    if (trimmed) prevTrimmed = trimmed
  }
  let result = deduped.join('')
  // 仅在非明显复读场景下回退，避免误伤正常长文。
  if (
    !skippedDuplicateSentence &&
    result.length < text.length * 0.8
  ) {
    result = text
  }

  // 2) 整段由同一短句周期重复（无换行、模型复读）；仅对较长文本尝试。
  if (result.length < 40) return result

  const minUnitLen = 10
  const maxUnit = Math.min(200, Math.floor(result.length / 3))
  for (let len = maxUnit; len >= minUnitLen; len--) {
    const unit = result.slice(0, len)
    const repeatCount = Math.floor(result.length / len)
    if (repeatCount >= 3 && unit.repeat(repeatCount) === result.slice(0, unit.length * repeatCount)) {
      return unit
    }
  }

  return result
}
