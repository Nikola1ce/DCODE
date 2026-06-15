// web_fetch 工具。
// 使用 Node 内置 fetch 抓取 URL，提取 body 纯文本；禁止 localhost/内网，超时 15s，最大 50KB。
// plan 模式下不可用；执行前需用户授权。
// 制作人：Moriarty_Dox

import {
  MAX_WEB_FETCH_CHARS,
  NETWORK_HARD_TIMEOUT_MS,
  PRODUCT_NAME,
  VERSION,
  WEB_FETCH_TIMEOUT_MS,
} from '../constants.js'
import type { PermissionRequest, ToolDefinition, ToolResult } from '../core/types.js'
import {
  extractBodyText,
  safeFetchText,
  truncateWebContent,
  validateFetchUrl,
  withHardTimeout,
} from './webUtils.js'

/** web_fetch 入参。 */
interface WebFetchInput {
  /** 要抓取的 URL（http/https）。 */
  url: string
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    '抓取指定 URL 的网页内容并返回 body 区域的纯文本（自动去除 HTML 标签与 script/style）。' +
    '适合查阅公开文档、API 说明、issue 页面等。' +
    '禁止访问 localhost 与内网地址；超时 15 秒；单次最多返回约 50KB 文本。' +
    'plan 模式下不可用；执行前需用户授权。',
  readOnly: false,
  safety: { sideEffect: 'network', parallelSafe: true },
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的完整 URL（http 或 https）' },
    },
    required: ['url'],
  },
  renderCall: (input: WebFetchInput) => `抓取 ${input.url}`,
  /**
   * 网络抓取需用户授权；bypass 模式跳过。
   * @param input 入参。
   * @param ctx 运行上下文。
   */
  checkPermission: (input: WebFetchInput, ctx): PermissionRequest | null => {
    if (ctx.permissionMode === 'bypass') return null
    const validated = validateFetchUrl(input.url ?? '')
    const host = validated.ok ? validated.url.hostname : input.url
    // ruleKey 采用工具级标识（不含域名）：用户选「总是允许」一次后，对所有网站的抓取都放行，
    // 避免下载/抓取任务里每换一个域名就要重新授权。title 仍展示具体域名，让用户知道访问目标。
    return {
      toolName: 'web_fetch',
      title: `访问网页：${host}`,
      preview: input.url,
      ruleKey: 'web_fetch',
    }
  },
  /**
   * 执行 URL 抓取并返回纯文本。
   * @param input 入参。
   * @param ctx 运行上下文（abortSignal 可取消请求）。
   * @returns 工具结果。
   */
  run: async (input: WebFetchInput, ctx): Promise<ToolResult> => {
    const validated = validateFetchUrl(input.url ?? '')
    if (!validated.ok) {
      return { llmContent: `错误：${validated.reason}`, isError: true }
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS)

    try {
      // 带进度抓取：按字节流读取响应体，把「百分比/已下载量/速度」实时上报到 CLI 实时区。
      // 进度条前缀用主机名，便于用户辨认正在下载的资源。
      // 外层再套「硬超时」护栏：即便底层 DNS/连接/读取/cancel 永久挂起，也保证按时返回，避免工具无限转圈。
      const fetched = await withHardTimeout(
        safeFetchText(validated.url.toString(), {
          init: {
            signal: controller.signal,
            headers: {
              'User-Agent': `${PRODUCT_NAME}/${VERSION}`,
              Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
            },
          },
          signal: controller.signal,
          label: validated.url.hostname,
          onProgressText: (line) => ctx.onProgress?.(line),
        }),
        NETWORK_HARD_TIMEOUT_MS,
        () => controller.abort(),
        ctx.abortSignal,
      )

      if (fetched.timedOut) {
        // 用户中断（Esc）立即返回「已取消」；否则为真正的超时。
        if (fetched.aborted || ctx.abortSignal.aborted) {
          return { llmContent: '抓取已被用户取消。', isError: true, uiSummary: 'web_fetch 已取消' }
        }
        return {
          llmContent:
            `抓取超时：${validated.url} 在 ${NETWORK_HARD_TIMEOUT_MS}ms 内未完成（连接挂起或响应过慢）。` +
            `\n提示：若要下载图片等二进制文件，请改用 run_command 执行下载命令` +
            `（Windows: Invoke-WebRequest -OutFile；类 Unix: curl -L -o）。`,
          isError: true,
          uiSummary: 'web_fetch 超时',
        }
      }
      const { res, text: raw } = fetched.value

      if (!res.ok) {
        return {
          llmContent: `HTTP ${res.status} ${res.statusText}：${validated.url}`,
          isError: true,
          uiSummary: `web_fetch ${res.status}`,
        }
      }

      const contentType = res.headers.get('content-type') ?? ''

      let text: string
      if (contentType.includes('text/html') || raw.trimStart().startsWith('<!')) {
        text = extractBodyText(raw)
      } else {
        text = raw.trim()
      }

      if (!text) {
        return {
          llmContent: `页面已抓取但无可用文本内容。\nURL: ${validated.url}\nContent-Type: ${contentType}`,
          uiSummary: 'web_fetch 无文本',
        }
      }

      const body = truncateWebContent(text, MAX_WEB_FETCH_CHARS)
      return {
        llmContent: `URL: ${validated.url}\n\n${body}`,
        uiSummary: `已抓取 ${validated.url.hostname}`,
      }
    } catch (e: any) {
      const msg =
        e?.name === 'AbortError'
          ? ctx.abortSignal.aborted
            ? '请求已被用户取消。'
            : `请求超时（${WEB_FETCH_TIMEOUT_MS}ms）。`
          : `抓取失败：${e?.message ?? String(e)}`
      return { llmContent: msg, isError: true, uiSummary: 'web_fetch 失败' }
    } finally {
      clearTimeout(timer)
      ctx.abortSignal.removeEventListener('abort', onAbort)
    }
  },
}
