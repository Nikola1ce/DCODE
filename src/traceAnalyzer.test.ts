import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function runAnalyzer(events: Array<Record<string, unknown>>): any {
  const dir = mkdtempSync(path.join(tmpdir(), 'dcode-trace-analyze-'))
  try {
    writeFileSync(
      path.join(dir, 'trace.jsonl'),
      events.map((event, index) => JSON.stringify({ seq: index + 1, ts: Date.now(), ...event })).join('\n'),
      'utf8',
    )
    const stdout = execFileSync('node', ['scripts/trace-analyze.mjs', dir], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    return JSON.parse(stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('trace analyzer', () => {
  it('classifies repeated provider deltas as provider-duplicate', () => {
    const result = runAnalyzer([
      { layer: 'provider', kind: 'yield_text', deltaHash: 'aaa', deltaLength: 32, deltaPreview: 'repeat block' },
      { layer: 'provider', kind: 'yield_text', deltaHash: 'aaa', deltaLength: 32, deltaPreview: 'repeat block' },
    ])

    expect(result.classification).toBe('provider-duplicate')
    expect(result.evidence.providerDuplicate.current.hash).toBe('aaa')
  })

  it('classifies repeated app static chunks as ui-double-commit', () => {
    const result = runAnalyzer([
      {
        layer: 'app',
        kind: 'static_push',
        chunks: [{ textHash: 'bbb', textLength: 48, textPreview: 'same committed chunk' }],
      },
      {
        layer: 'app',
        kind: 'static_push',
        chunks: [{ textHash: 'bbb', textLength: 48, textPreview: 'same committed chunk' }],
      },
    ])

    expect(result.classification).toBe('ui-double-commit')
    expect(result.evidence.appDuplicate.current.hash).toBe('bbb')
  })

  it('classifies repeated stdout-only text as ink-stdout-frame-leak', () => {
    const line = '叶文洁发现了太阳的放大效应，她利用这个机会向宇宙发出了人类的第一条信息。'
    const result = runAnalyzer([
      {
        layer: 'ink',
        kind: 'stdout_write',
        textLength: line.length * 3 + 2,
        textHash: 'ccc',
        textFullText: `${line}\n${line}\n${line}`,
      },
    ])

    expect(result.classification).toBe('ink-stdout-frame-leak')
    expect(result.evidence.stdoutLeak.type).toBe('repeated-line')
  })

  it('classifies incremental live frame redraws as ink-stdout-frame-leak', () => {
    // base 需足够长，使相邻帧的公共前缀 ≥ 40（分析器判定「增量实时帧重绘」的阈值），
    // 才能真实还原「长回答稳定、仅尾部逐字增长」的流式重绘场景。
    const base =
      '  - 叶文洁在红岸基地利用太阳作为放大器，向遥远的宇宙深处发送了人类文明的第一条信号，'
    const result = runAnalyzer([
      {
        layer: 'ink',
        kind: 'stdout_write',
        textLength: 80,
        textFullText: `${base}该\n\n⠙ 正在回答…　按 Esc 中断\n`,
      },
      {
        layer: 'ink',
        kind: 'stdout_write',
        textLength: 82,
        textFullText: `${base}该信\n\n⠹ 正在回答…　按 Esc 中断\n`,
      },
      {
        layer: 'ink',
        kind: 'stdout_write',
        textLength: 84,
        textFullText: `${base}该信号\n\n⠸ 正在回答…　按 Esc 中断\n`,
      },
      {
        layer: 'ink',
        kind: 'stdout_write',
        textLength: 86,
        textFullText: `${base}该信号被\n\n⠼ 正在回答…　按 Esc 中断\n`,
      },
      {
        layer: 'ink',
        kind: 'stdout_write',
        textLength: 88,
        textFullText: `${base}该信号被三\n\n⠴ 正在回答…　按 Esc 中断\n`,
      },
      {
        layer: 'ink',
        kind: 'stdout_write',
        textLength: 90,
        textFullText: `${base}该信号被三体\n\n⠦ 正在回答…　按 Esc 中断\n`,
      },
    ])

    expect(result.classification).toBe('ink-stdout-frame-leak')
    expect(result.evidence.stdoutLeak.type).toBe('incremental-live-frame-redraw')
  })

  it('returns terminal-only-artifact when no duplicate evidence exists', () => {
    const result = runAnalyzer([
      { layer: 'provider', kind: 'yield_text', deltaHash: 'one', deltaLength: 12, deltaPreview: 'hello' },
      { layer: 'runner', kind: 'text_delta', deltaHash: 'two', deltaLength: 12, deltaPreview: 'world' },
    ])

    expect(result.classification).toBe('terminal-only-artifact')
  })
})
