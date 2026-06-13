#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const traceDir = process.argv[2]
if (!traceDir) {
  console.error('Usage: npm run trace:analyze -- <traceDir>')
  process.exit(1)
}

const tracePath = path.join(traceDir, 'trace.jsonl')
if (!fs.existsSync(tracePath)) {
  console.error(`trace.jsonl not found: ${tracePath}`)
  process.exit(1)
}

const events = fs
  .readFileSync(tracePath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (err) {
      return { layer: 'invalid', kind: 'invalid_json', seq: index + 1, error: String(err), raw: line }
    }
  })

const result = analyzeEvents(events)
console.log(JSON.stringify(result, null, 2))

export function analyzeEvents(events) {
  const providerDuplicate = findAdjacentHashDuplicate(events, 'provider', ['yield_text', 'text_incoming'], [
    'delta',
    'emitted',
  ])
  const runnerDuplicate = findAdjacentHashDuplicate(events, 'runner', ['text_delta'], ['delta'])
  const committerDuplicate = findAdjacentHashDuplicate(events, 'committer', ['commit_chunk'], ['text'])
  const appDuplicate = findChunkDuplicate(events, 'app', ['static_push'])
  const stdoutLeak = findStdoutRepeat(events)

  const classification = providerDuplicate
    ? 'provider-duplicate'
    : runnerDuplicate
      ? 'runner-double-consume'
      : committerDuplicate || appDuplicate
        ? 'ui-double-commit'
        : stdoutLeak
          ? 'ink-stdout-frame-leak'
          : 'terminal-only-artifact'

  return {
    classification,
    counts: countByLayerKind(events),
    layerHashes: summarizeLayerHashes(events),
    evidence: {
      providerDuplicate,
      runnerDuplicate,
      committerDuplicate,
      appDuplicate,
      stdoutLeak,
    },
  }
}

function findAdjacentHashDuplicate(events, layer, kinds, prefixes) {
  let prev = null
  for (const event of events) {
    if (event.layer !== layer || !kinds.includes(event.kind)) continue
    for (const prefix of prefixes) {
      const hash = event[`${prefix}Hash`]
      const length = Number(event[`${prefix}Length`] ?? 0)
      if (!hash || length < 20 || isSeparatorPreview(event[`${prefix}Preview`])) continue
      const current = {
        layer,
        kind: event.kind,
        prefix,
        hash,
        length,
        seq: event.seq,
        preview: event[`${prefix}Preview`] ?? '',
      }
      if (prev && prev.hash === current.hash && prev.prefix === current.prefix) {
        return { previous: prev, current }
      }
      prev = current
    }
  }
  return null
}

function findChunkDuplicate(events, layer, kinds) {
  let prev = null
  for (const event of events) {
    if (event.layer !== layer || !kinds.includes(event.kind)) continue
    const chunks = Array.isArray(event.chunks) ? event.chunks : []
    for (const chunk of chunks) {
      const hash = chunk.textHash
      const length = Number(chunk.textLength ?? 0)
      if (!hash || length < 20 || chunk.spacer || isSeparatorPreview(chunk.textPreview)) continue
      const current = {
        layer,
        kind: event.kind,
        hash,
        length,
        seq: event.seq,
        preview: chunk.textPreview ?? '',
      }
      if (prev && prev.hash === current.hash) return { previous: prev, current }
      prev = current
    }
  }
  return null
}

function findStdoutRepeat(events) {
  const stdoutEvents = events.filter((event) => event.layer === 'ink' && event.kind === 'stdout_write')
  const redraw = findIncrementalFrameRedraw(stdoutEvents)
  if (redraw) return redraw
  for (const event of stdoutEvents) {
    const text = event.textFullText ?? event.text ?? ''
    if (typeof text !== 'string' || text.length < 40) continue
    const lineRepeat = findRepeatedLine(text)
    if (lineRepeat) {
      return {
        seq: event.seq,
        type: 'repeated-line',
        ...lineRepeat,
      }
    }
    const windowRepeat = findImmediateWindowRepeat(text)
    if (windowRepeat) {
      return {
        seq: event.seq,
        type: 'immediate-window',
        ...windowRepeat,
      }
    }
  }
  return null
}

function findIncrementalFrameRedraw(stdoutEvents) {
  let streak = 0
  let previous = ''
  let startSeq = null
  for (const event of stdoutEvents) {
    const text = event.textFullText ?? event.text ?? ''
    if (typeof text !== 'string' || text.length < 40 || !/正在(回答|推理)/.test(text)) {
      streak = 0
      previous = ''
      startSeq = null
      continue
    }
    // 判定「增量实时帧重绘」：后一帧是在前一帧基础上追加少量内容（公共前缀占前一帧绝大部分）。
    // 不能用固定绝对值（如 40），因为正文前缀可能很短（如「  - 某行」仅 20 余字符），
    // 那样会漏判；改用「公共前缀≥20 且占前一帧长度≥40%」兼顾短前缀场景与误判防控。
    const common = commonPrefixLength(previous, text)
    if (previous && common >= 20 && common >= previous.length * 0.4) {
      streak += 1
      startSeq ??= event.seq
      if (streak >= 5) {
        return {
          seq: event.seq,
          type: 'incremental-live-frame-redraw',
          startSeq,
          streak,
          commonPrefixLength: common,
          preview: text.slice(0, 160),
        }
      }
    } else {
      streak = 1
      startSeq = event.seq
    }
    previous = text
  }
  return null
}

function findRepeatedLine(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12)
  let prev = ''
  let count = 0
  for (const line of lines) {
    if (line === prev) {
      count += 1
      if (count >= 3) return { count, preview: line.slice(0, 160) }
    } else {
      prev = line
      count = 1
    }
  }
  return null
}

function findImmediateWindowRepeat(text) {
  const normalized = text.replace(/\s+/g, ' ')
  for (let size = 24; size <= Math.min(180, Math.floor(normalized.length / 3)); size += 4) {
    for (let i = 0; i + size * 3 <= normalized.length; i++) {
      const a = normalized.slice(i, i + size)
      if (a.trim().length < 12) continue
      const b = normalized.slice(i + size, i + size * 2)
      const c = normalized.slice(i + size * 2, i + size * 3)
      if (a === b && b === c) return { repeats: 3, size, preview: a.slice(0, 160) }
    }
  }
  return null
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i += 1
  return i
}

function isSeparatorPreview(value) {
  return typeof value === 'string' && /^[\s\-_*`#=]+$/.test(value)
}

function countByLayerKind(events) {
  const counts = {}
  for (const event of events) {
    const key = `${event.layer}:${event.kind}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function summarizeLayerHashes(events) {
  const summary = {}
  for (const event of events) {
    const layer = event.layer ?? 'unknown'
    summary[layer] ??= { textHashes: 0, uniqueTextHashes: 0, hashes: new Set() }
    for (const [key, value] of Object.entries(event)) {
      if (!key.endsWith('Hash') || typeof value !== 'string') continue
      summary[layer].textHashes += 1
      summary[layer].hashes.add(value)
    }
  }
  for (const value of Object.values(summary)) {
    value.uniqueTextHashes = value.hashes.size
    delete value.hashes
  }
  return summary
}
