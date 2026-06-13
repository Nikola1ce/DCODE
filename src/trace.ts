import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export type TraceLayer = 'provider' | 'runner' | 'agent' | 'app' | 'committer' | 'ink'

export interface TraceContext {
  runId?: string
  turnId?: string
  iteration?: number
}

export interface TraceTextInfo {
  length: number
  hash: string
  preview: string
  visualCols: number
  fullText?: string
}

const TRACE_ID = `${Date.now().toString(36)}-${randomUUID()}`
let seq = 0
let stdoutInstalled = false

export function isTraceEnabled(): boolean {
  return !!process.env.DCODE_TRACE_DIR
}

export function traceTextInfo(text: string): TraceTextInfo {
  const redacted = redactSecrets(text)
  const info: TraceTextInfo = {
    length: redacted.length,
    hash: hashText(redacted),
    preview: redacted.length > 160 ? `${redacted.slice(0, 160)}...` : redacted,
    visualCols: visualCols(redacted),
  }
  if (shouldIncludeFullText()) info.fullText = redacted
  return info
}

export function traceTextFields(prefix: string, text: string): Record<string, unknown> {
  const info = traceTextInfo(text)
  return {
    [`${prefix}Length`]: info.length,
    [`${prefix}Hash`]: info.hash,
    [`${prefix}Preview`]: info.preview,
    [`${prefix}VisualCols`]: info.visualCols,
    ...(info.fullText !== undefined ? { [prefix]: info.fullText, [`${prefix}FullText`]: info.fullText } : {}),
  }
}

export function traceEvent(
  layer: TraceLayer,
  kind: string,
  data: Record<string, unknown> = {},
  context: TraceContext = {},
): void {
  if (!isTraceEnabled()) return
  const dir = process.env.DCODE_TRACE_DIR
  if (!dir) return
  try {
    mkdirSync(dir, { recursive: true })
    const event = sanitize({
      traceId: TRACE_ID,
      seq: ++seq,
      ts: Date.now(),
      layer,
      kind,
      ...context,
      ...data,
    })
    appendFileSync(path.join(dir, 'trace.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
  } catch {
    // Trace logging must never affect product behavior.
  }
}

export function installStdoutTrace(): void {
  if (!isTraceEnabled() || process.env.DCODE_TRACE_STDOUT !== '1') return
  if (stdoutInstalled) return
  stdoutInstalled = true

  const stdout = process.stdout as NodeJS.WriteStream & {
    __dcodeTraceOriginalWrite?: NodeJS.WriteStream['write']
  }
  if (stdout.__dcodeTraceOriginalWrite) return

  const originalWrite = stdout.write.bind(stdout) as NodeJS.WriteStream['write']
  stdout.__dcodeTraceOriginalWrite = originalWrite

  ;(stdout as any).write = function tracedWrite(
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((err?: Error) => void),
    callback?: (err?: Error) => void,
  ): boolean {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8'
    const raw = Buffer.isBuffer(chunk) ? chunk.toString(encoding) : String(chunk)
    const stripped = stripAnsi(raw)
    traceEvent('ink', 'stdout_write', {
      rawLength: raw.length,
      rawHash: hashText(redactSecrets(raw)),
      strippedAnsiLength: stripped.length,
      ...traceTextFields('text', stripped),
    })
    return originalWrite(chunk as any, encodingOrCallback as any, callback as any)
  }
}

export function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, '')
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function shouldIncludeFullText(): boolean {
  const value = process.env.DCODE_TRACE_FULL_TEXT
  return value === undefined || (value !== '0' && value.toLowerCase() !== 'false')
}

function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(api[_-]?key["'\s:=]+)([A-Za-z0-9._-]{8,})/gi, '$1[REDACTED]')
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    const redacted = redactSecrets(value)
    if (!shouldIncludeFullText() && redacted.length > 200) {
      return `${redacted.slice(0, 200)}...`
    }
    return redacted
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (depth > 5) return '[MaxDepth]'
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitize(item, depth + 1)
    }
    return out
  }
  return String(value)
}

function visualCols(text: string): number {
  let cols = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    cols += cp > 0x1100 && isWideCodePoint(cp) ? 2 : 1
  }
  return cols
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  )
}
