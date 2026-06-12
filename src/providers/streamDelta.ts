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

  // 标准增量模式。
  return { next: accumulated + incoming, delta: incoming }
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
