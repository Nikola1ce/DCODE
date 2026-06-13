import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { traceEvent, traceTextFields, stripAnsi } from './trace.js'

const originalTraceDir = process.env.DCODE_TRACE_DIR
const originalFullText = process.env.DCODE_TRACE_FULL_TEXT

afterEach(() => {
  if (originalTraceDir === undefined) delete process.env.DCODE_TRACE_DIR
  else process.env.DCODE_TRACE_DIR = originalTraceDir
  if (originalFullText === undefined) delete process.env.DCODE_TRACE_FULL_TEXT
  else process.env.DCODE_TRACE_FULL_TEXT = originalFullText
})

describe('trace diagnostics', () => {
  it('does not write files when DCODE_TRACE_DIR is not set', () => {
    delete process.env.DCODE_TRACE_DIR
    const dir = mkdtempSync(path.join(tmpdir(), 'dcode-trace-off-'))

    traceEvent('provider', 'text_incoming', { ...traceTextFields('text', 'hello') })

    expect(() => readFileSync(path.join(dir, 'trace.jsonl'), 'utf8')).toThrow()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes parseable JSONL with full text metadata when enabled', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dcode-trace-on-'))
    process.env.DCODE_TRACE_DIR = dir
    process.env.DCODE_TRACE_FULL_TEXT = '1'

    traceEvent('provider', 'text_incoming', {
      ...traceTextFields('text', 'hello world'),
    })

    const line = readFileSync(path.join(dir, 'trace.jsonl'), 'utf8').trim()
    const event = JSON.parse(line)
    expect(event.layer).toBe('provider')
    expect(event.kind).toBe('text_incoming')
    expect(event.textLength).toBe(11)
    expect(event.textHash).toMatch(/^[a-f0-9]{16}$/)
    expect(event.textFullText).toBe('hello world')
    rmSync(dir, { recursive: true, force: true })
  })

  it('redacts API keys from full text logs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dcode-trace-redact-'))
    process.env.DCODE_TRACE_DIR = dir
    process.env.DCODE_TRACE_FULL_TEXT = '1'

    traceEvent('provider', 'text_incoming', {
      ...traceTextFields('text', 'key sk-ea20a613c10c4d458279d4b586d11819 should not leak'),
    })

    const raw = readFileSync(path.join(dir, 'trace.jsonl'), 'utf8')
    expect(raw).not.toContain('sk-ea20a613c10c4d458279d4b586d11819')
    expect(raw).toContain('[REDACTED]')
    rmSync(dir, { recursive: true, force: true })
  })

  it('strips ANSI sequences for stdout diagnostics', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m plain')).toBe('red plain')
  })
})
