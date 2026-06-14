// 通用「带进度的网络下载/读取」工具。
// 背景：DCODE 中多处需要从网络拉取资源（更新检测/下载、web_fetch 抓取网页、web_search 调用搜索 API）。
// 本模块统一封装「按字节流读取 Response Body + 实时计算进度（百分比/已下载量/速度/ETA）」的逻辑，
// 并提供把进度渲染成一行 ASCII 进度条文本的函数，供 CLI 实时区（tool_progress / 命令进度）展示。
// 设计要点：
//   1) 不依赖第三方库，使用 Node 内置 fetch + Web Streams（ReadableStream）逐块读取；
//   2) 进度上报做节流（默认 ~120ms 一次），避免高频刷新拖垮终端重绘；
//   3) 有 Content-Length 时显示真实百分比与 ETA，无则降级为「已下载量 + 速度」；
//   4) 支持 AbortSignal 取消。
// 制作人：Moriarty_Dox

/** 下载/读取过程中的一次进度快照。 */
export interface DownloadProgress {
  /** 已接收字节数。 */
  receivedBytes: number
  /** 资源总字节数；服务端未提供 Content-Length 时为 null（无法计算百分比）。 */
  totalBytes: number | null
  /** 已下载占比 [0,1]；total 未知时为 null。 */
  ratio: number | null
  /** 平均下载速度（字节/秒），基于起始时间与已接收量估算。 */
  bytesPerSecond: number
  /** 预计剩余时间（秒）；total 未知或速度为 0 时为 null。 */
  etaSeconds: number | null
  /** 自下载开始以来经过的毫秒数。 */
  elapsedMs: number
  /** 是否为最终一帧（读取结束时回调一次，便于显示 100%）。 */
  done: boolean
}

/** 进度回调函数签名。 */
export type ProgressReporter = (progress: DownloadProgress) => void

/** downloadWithProgress / readResponseWithProgress 的可选项。 */
export interface DownloadOptions {
  /** 进度回调（已内部节流）。 */
  onProgress?: ProgressReporter
  /** 取消信号。 */
  signal?: AbortSignal
  /** 进度回调最小间隔（毫秒），默认 120ms；设为 0 表示每块都回调（一般不建议）。 */
  throttleMs?: number
  /** 透传给 fetch 的请求头。 */
  headers?: Record<string, string>
  /** 进度条展示用的资源名（仅用于上层渲染，可选）。 */
  label?: string
}

/** 进度条默认字符宽度（格子数）。 */
const PROGRESS_BAR_WIDTH = 24
/** 已填充 / 未填充使用的字符。 */
const BAR_FILLED = '█'
const BAR_EMPTY = '░'
/** 总量未知时的「流动」动画帧（无百分比时给出视觉反馈）。 */
const INDETERMINATE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * 把字节数格式化为带单位的紧凑字符串（1024 进制：B/KB/MB/GB）。
 * @param bytes 字节数（负数按 0 处理）。
 * @returns 形如 "512 B" / "1.3 MB" 的字符串。
 */
export function formatBytes(bytes: number): string {
  const v = Math.max(0, bytes)
  if (v < 1024) return `${Math.round(v)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = v / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  // 小于 10 时保留 1 位小数，便于看清；更大则取整，避免冗余。
  const text = n < 10 ? n.toFixed(1) : Math.round(n).toString()
  return `${text} ${units[i]}`
}

/**
 * 把下载速度（字节/秒）格式化为 "X/s" 形式。
 * @param bytesPerSecond 速度。
 * @returns 形如 "1.3 MB/s" 的字符串。
 */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * 把剩余秒数格式化为 "Xs" / "Xm Ys" 的简短形式。
 * @param seconds 秒数；null/非有限值返回占位 "--"。
 * @returns 形如 "5s" / "1m 20s" / "--" 的字符串。
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '--'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest === 0 ? `${m}m` : `${m}m ${rest}s`
}

/**
 * 把一次进度快照渲染成一行可读的进度条文本（供 CLI 实时区展示）。
 * - 已知总量：`[████████░░░░░░] 57% · 5.7/10 MB · 1.3 MB/s · ETA 4s`
 * - 未知总量：`⠹ 已下载 5.7 MB · 1.3 MB/s`
 * @param p 进度快照。
 * @param label 资源名（可选，前缀展示，如 "更新包"）。
 * @returns 单行进度文本（不含换行）。
 */
export function renderProgressBar(p: DownloadProgress, label?: string): string {
  const prefix = label ? `${label} ` : ''
  if (p.ratio !== null && p.totalBytes !== null) {
    const filled = Math.max(0, Math.min(PROGRESS_BAR_WIDTH, Math.round(p.ratio * PROGRESS_BAR_WIDTH)))
    const bar = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(PROGRESS_BAR_WIDTH - filled)
    const percent = Math.round(p.ratio * 100)
    const sizeText = `${formatBytes(p.receivedBytes)}/${formatBytes(p.totalBytes)}`
    const speedText = p.bytesPerSecond > 0 ? ` · ${formatSpeed(p.bytesPerSecond)}` : ''
    const etaText = p.done ? '' : ` · ETA ${formatDuration(p.etaSeconds)}`
    return `${prefix}[${bar}] ${percent}% · ${sizeText}${speedText}${etaText}`
  }
  // 总量未知：用「流动 spinner + 已下载量 + 速度」给出反馈。
  const frame = p.done
    ? '✓'
    : INDETERMINATE_FRAMES[Math.floor(p.elapsedMs / 80) % INDETERMINATE_FRAMES.length]
  const speedText = p.bytesPerSecond > 0 ? ` · ${formatSpeed(p.bytesPerSecond)}` : ''
  return `${prefix}${frame} 已下载 ${formatBytes(p.receivedBytes)}${speedText}`
}

/**
 * 解析 Content-Length 头为字节数。
 * @param res Response 对象。
 * @returns 字节数；缺失或非法时为 null。
 */
function parseContentLength(res: Response): number | null {
  const raw = res.headers.get('content-length')
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * 基于一个已拿到的 Response，按字节流读取其 body 并实时上报进度，最终返回完整字节。
 * 适用于「已经自行处理好 URL 校验/重定向」的场景（如 web_fetch 的 safeFetch）。
 * 若 Response.body 不可读（无流，如某些 polyfill），降级为一次性 arrayBuffer 并上报单帧进度。
 * @param res 已发起的 Response（其 body 尚未被消费）。
 * @param options 进度/取消选项。
 * @returns 完整响应体字节（Uint8Array）。
 */
export async function readResponseWithProgress(
  res: Response,
  options: DownloadOptions = {},
): Promise<Uint8Array> {
  const { onProgress, signal, throttleMs = 120, label } = options
  const totalBytes = parseContentLength(res)
  const startedAt = Date.now()

  // 构造一次进度快照。
  const makeProgress = (received: number, done: boolean): DownloadProgress => {
    const elapsedMs = Date.now() - startedAt
    const seconds = elapsedMs / 1000
    const bytesPerSecond = seconds > 0 ? received / seconds : 0
    const ratio = totalBytes && totalBytes > 0 ? Math.min(1, received / totalBytes) : null
    const etaSeconds =
      ratio !== null && bytesPerSecond > 0 && totalBytes !== null
        ? Math.max(0, (totalBytes - received) / bytesPerSecond)
        : null
    return { receivedBytes: received, totalBytes, ratio, bytesPerSecond, etaSeconds, elapsedMs, done }
  }

  // body 不可读：降级一次性读取（仍尽量给出首尾两帧进度）。
  const body = res.body as ReadableStream<Uint8Array> | null
  if (!body || typeof body.getReader !== 'function') {
    onProgress?.(makeProgress(0, false))
    const buf = new Uint8Array(await res.arrayBuffer())
    onProgress?.(makeProgress(buf.byteLength, true))
    return buf
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let lastReportAt = 0

  // 首帧：立即给出 0%/已下载 0，让用户马上看到进度条出现。
  onProgress?.(makeProgress(0, false))

  // 取消处理：中断时尝试 cancel reader 以尽快释放连接。
  const onAbort = () => {
    void reader.cancel().catch(() => {})
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        chunks.push(value)
        received += value.byteLength
        const now = Date.now()
        // 节流：距上次上报超过 throttleMs 才回调，降低终端重绘频率。
        if (onProgress && (throttleMs <= 0 || now - lastReportAt >= throttleMs)) {
          lastReportAt = now
          onProgress(makeProgress(received, false))
        }
      }
      if (signal?.aborted) {
        throw new DOMExceptionLike('下载已被取消', 'AbortError')
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  // 末帧：保证显示一次「完成（100% / ✓）」。
  onProgress?.(makeProgress(received, true))

  // 合并所有分块为一个连续缓冲区。
  const out = new Uint8Array(received)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/**
 * 直接对一个 URL 发起下载并实时上报进度，返回完整字节。
 * 适用于「URL 已可信」的场景（如更新包下载）。需要 SSRF 校验的网页抓取请改用 webUtils.safeFetch。
 * @param url 目标 URL。
 * @param options 进度/取消/请求头选项。
 * @returns 完整响应体字节。
 */
export async function downloadWithProgress(
  url: string,
  options: DownloadOptions = {},
): Promise<Uint8Array> {
  const res = await fetch(url, {
    signal: options.signal,
    headers: options.headers,
  })
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${url}）`)
  }
  return readResponseWithProgress(res, options)
}

/**
 * 轻量的 DOMException 替身：Node 环境下统一抛出 name='AbortError' 的错误，
 * 便于上层用 `e?.name === 'AbortError'` 区分「取消」与「真实失败」。
 */
class DOMExceptionLike extends Error {
  constructor(message: string, name: string) {
    super(message)
    this.name = name
  }
}
