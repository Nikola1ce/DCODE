// web_search 工具。
// 默认走「零 Key」的 Bing 网页搜索（抓取 cn.bing.com 搜索结果页并解析），无需任何 API Key 即可联网搜索；
// 若用户额外配置了 SERPAPI_API_KEY 或 BING_SEARCH_API_KEY，则优先使用对应官方 API（结果更稳更准）。
// 这样既保证「开箱即用」（对齐 Claude Code 无需配 Key 的体验），又兼容已有付费 Key 用户。
// plan 模式下不可用；执行前需用户授权。
// 制作人：Moriarty_Dox

import {
  BING_SEARCH_ENDPOINT,
  ENV_BING_SEARCH_KEY,
  ENV_SERPAPI_KEY,
  NETWORK_HARD_TIMEOUT_MS,
  PRODUCT_NAME,
  VERSION,
  WEB_SEARCH_TIMEOUT_MS,
} from '../constants.js'
import type { PermissionRequest, ToolDefinition, ToolResult } from '../core/types.js'
import { readResponseWithProgress, renderProgressBar } from '../core/download.js'
import { withHardTimeout } from './webUtils.js'

// 零 Key 网页搜索端点：Bing 国内站搜索结果页（国内可直连，无需 API Key）。
// 说明：这是抓取「网页版搜索结果」而非 Bing 付费 Search API；解析其 HTML 结果列表。
// DuckDuckGo 在国内网络多不可达，故选 Bing 网页版作为默认免费后端。
const BING_WEB_SEARCH_PAGE = 'https://cn.bing.com/search'

// 抓取网页搜索时伪装的浏览器 User-Agent（避免被返回精简版/拒绝）。
const WEB_SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * 带进度地发起 GET 请求并解析 JSON 响应。
 * 搜索 API 的响应体通常较小且可能无 Content-Length，此处仍按字节流读取并上报进度，
 * 让「联网搜索」也有可见的下载反馈（无总量时显示已下载量 + 速度）。
 * @param url 请求 URL。
 * @param init fetch 选项（headers / signal）。
 * @param onProgress 进度文本回调（接 ctx.onProgress）。
 * @param label 进度条前缀标签。
 * @returns 解析后的 JSON 对象与原始 Response。
 */
async function fetchJsonWithProgress<T>(
  url: URL,
  init: RequestInit,
  onProgress: ((text: string) => void) | undefined,
  label: string,
): Promise<{ res: Response; data: T }> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`${label} HTTP ${res.status}: ${errText.slice(0, 200)}`)
  }
  const bytes = await readResponseWithProgress(res, {
    signal: init.signal as AbortSignal | undefined,
    label,
    onProgress: onProgress ? (p) => onProgress(renderProgressBar(p, label)) : undefined,
  })
  const text = new TextDecoder('utf-8').decode(bytes)
  return { res, data: JSON.parse(text) as T }
}

/** web_search 入参。 */
interface WebSearchInput {
  /** 搜索关键词。 */
  search_term: string
  /** 返回结果数量（1–10，默认 5）。 */
  num_results?: number
}

/** 单条搜索结果。 */
interface SearchResultItem {
  title: string
  url: string
  snippet: string
}

/**
 * 解析已配置的搜索 API Key（SerpAPI 优先，其次 Bing）。
 * @returns provider 与 key，未配置时 key 为空。
 */
export function resolveSearchApiKey(): {
  provider: 'serpapi' | 'bing' | null
  apiKey: string | null
} {
  const serp = process.env[ENV_SERPAPI_KEY]?.trim()
  if (serp) return { provider: 'serpapi', apiKey: serp }
  const bing = process.env[ENV_BING_SEARCH_KEY]?.trim()
  if (bing) return { provider: 'bing', apiKey: bing }
  return { provider: null, apiKey: null }
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    '搜索 Web 获取最新信息（文档、新闻、API 变更等）。' +
    '默认无需任何 API Key（走 Bing 网页搜索）；若配置了 SERPAPI_API_KEY 或 BING_SEARCH_API_KEY 则优先用官方 API。' +
    'plan 模式下不可用；执行前需用户授权。',
  readOnly: false,
  safety: { sideEffect: 'network', parallelSafe: true },
  parameters: {
    type: 'object',
    properties: {
      search_term: { type: 'string', description: '搜索关键词或问句' },
      num_results: {
        type: 'number',
        description: '返回结果数量（1-10，默认 5）',
      },
    },
    required: ['search_term'],
  },
  renderCall: (input: WebSearchInput) => `搜索：${input.search_term}`,
  /**
   * Web 搜索需用户授权。
   * @param input 入参。
   * @param ctx 运行上下文。
   */
  checkPermission: (input: WebSearchInput, ctx): PermissionRequest | null => {
    if (ctx.permissionMode === 'bypass') return null
    return {
      toolName: 'web_search',
      title: `Web 搜索：${input.search_term}`,
      preview: input.search_term,
      ruleKey: `web_search`,
    }
  },
  /**
   * 执行 Web 搜索并格式化结果列表。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果。
   */
  run: async (input: WebSearchInput, ctx): Promise<ToolResult> => {
    const term = input.search_term?.trim()
    if (!term) {
      return { llmContent: '错误：search_term 不能为空。', isError: true }
    }

    // 选择后端：优先官方 API（若配 Key），否则回退「零 Key」Bing 网页搜索。
    const { provider, apiKey } = resolveSearchApiKey()
    const backend: 'serpapi' | 'bing' | 'bing-web' = provider ?? 'bing-web'

    const count = clampResults(input.num_results ?? 5)
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS)

    try {
      // 发起前先提示「正在搜索」，让实时区立即有反馈（搜索结果到达前的空窗期）。
      ctx.onProgress?.(`⠋ 正在搜索「${term}」…`)
      // 硬超时护栏：即便底层连接/读取永久挂起，也保证按时返回，避免工具无限转圈。
      const searched = await withHardTimeout(
        (async (): Promise<SearchResultItem[]> => {
          if (backend === 'serpapi') {
            return searchViaSerpApi(term, count, apiKey!, controller.signal, ctx.onProgress)
          }
          if (backend === 'bing') {
            return searchViaBing(term, count, apiKey!, controller.signal, ctx.onProgress)
          }
          // 零 Key 默认后端：抓取 Bing 网页搜索结果并解析。
          return searchViaBingWeb(term, count, controller.signal, ctx.onProgress)
        })(),
        NETWORK_HARD_TIMEOUT_MS,
        () => controller.abort(),
        ctx.abortSignal,
      )
      if (searched.timedOut) {
        if (searched.aborted || ctx.abortSignal.aborted) {
          return { llmContent: '搜索已被用户取消。', isError: true, uiSummary: 'web_search 已取消' }
        }
        return {
          llmContent: `搜索超时：「${term}」在 ${NETWORK_HARD_TIMEOUT_MS}ms 内未完成（连接挂起或响应过慢）。`,
          isError: true,
          uiSummary: 'web_search 超时',
        }
      }
      const items = searched.value

      if (items.length === 0) {
        return {
          llmContent: `未找到与「${term}」相关的搜索结果。`,
          uiSummary: 'web_search 无结果',
        }
      }

      const backendLabel =
        backend === 'serpapi' ? 'SerpAPI' : backend === 'bing' ? 'Bing API' : 'Bing 网页'
      const lines = items.map(
        (item, i) =>
          `${i + 1}. ${item.title}\n   URL: ${item.url}\n   ${item.snippet}`,
      )
      return {
        llmContent: `搜索「${term}」的结果（${backendLabel}，${items.length} 条）：\n\n${lines.join('\n\n')}`,
        uiSummary: `搜索 ${term}（${items.length} 条）`,
      }
    } catch (e: any) {
      const msg =
        e?.name === 'AbortError'
          ? ctx.abortSignal.aborted
            ? '搜索已被用户取消。'
            : `搜索超时（${WEB_SEARCH_TIMEOUT_MS}ms）。`
          : `搜索失败：${e?.message ?? String(e)}`
      return { llmContent: msg, isError: true }
    } finally {
      clearTimeout(timer)
      ctx.abortSignal.removeEventListener('abort', onAbort)
    }
  },
}

/**
 * 限制搜索结果数量在 1–10。
 * @param n 请求数量。
 * @returns 合法数量。
 */
function clampResults(n: number): number {
  if (!Number.isFinite(n)) return 5
  return Math.min(10, Math.max(1, Math.floor(n)))
}

/**
 * 通过 SerpAPI 搜索（Google 引擎）。
 * @param term 关键词。
 * @param count 结果数。
 * @param apiKey API Key。
 * @param signal 取消信号。
 * @param onProgress 进度文本回调（下载搜索结果时实时上报）。
 */
async function searchViaSerpApi(
  term: string,
  count: number,
  apiKey: string,
  signal: AbortSignal,
  onProgress?: (text: string) => void,
): Promise<SearchResultItem[]> {
  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google')
  url.searchParams.set('q', term)
  url.searchParams.set('num', String(count))
  url.searchParams.set('api_key', apiKey)

  const { data } = await fetchJsonWithProgress<{
    organic_results?: { title?: string; link?: string; snippet?: string }[]
  }>(
    url,
    { signal, headers: { 'User-Agent': `${PRODUCT_NAME}/${VERSION}` } },
    onProgress,
    'SerpAPI',
  )
  return (data.organic_results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? '(无标题)',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }))
}

/**
 * 通过 Bing Web Search API v7 搜索。
 * @param term 关键词。
 * @param count 结果数。
 * @param apiKey API Key。
 * @param signal 取消信号。
 * @param onProgress 进度文本回调（下载搜索结果时实时上报）。
 */
async function searchViaBing(
  term: string,
  count: number,
  apiKey: string,
  signal: AbortSignal,
  onProgress?: (text: string) => void,
): Promise<SearchResultItem[]> {
  const url = new URL(BING_SEARCH_ENDPOINT)
  url.searchParams.set('q', term)
  url.searchParams.set('count', String(count))
  url.searchParams.set('textFormat', 'Raw')

  const { data } = await fetchJsonWithProgress<{
    webPages?: { value?: { name?: string; url?: string; snippet?: string }[] }
  }>(
    url,
    {
      signal,
      headers: {
        'User-Agent': `${PRODUCT_NAME}/${VERSION}`,
        'Ocp-Apim-Subscription-Key': apiKey,
      },
    },
    onProgress,
    'Bing Search',
  )
  return (data.webPages?.value ?? []).slice(0, count).map((r) => ({
    title: r.name ?? '(无标题)',
    url: r.url ?? '',
    snippet: r.snippet ?? '',
  }))
}

/**
 * 「零 Key」后端：抓取 Bing 网页搜索结果页（cn.bing.com/search）并解析结果列表。
 * 无需任何 API Key，国内网络可直连，是默认搜索后端。
 * 解析策略：每条结果位于 <li class="b_algo"> 内；标题在 <h2><a href>，摘要在 <p>（b_caption 内）。
 * 网页结构可能随 Bing 改版变化，故对解析失败做容错（解析不到则返回空列表，由上层提示无结果）。
 * @param term 关键词。
 * @param count 结果数。
 * @param signal 取消信号。
 * @param onProgress 进度文本回调（下载结果页时实时上报）。
 * @returns 结果列表。
 */
async function searchViaBingWeb(
  term: string,
  count: number,
  signal: AbortSignal,
  onProgress?: (text: string) => void,
): Promise<SearchResultItem[]> {
  const url = new URL(BING_WEB_SEARCH_PAGE)
  url.searchParams.set('q', term)
  url.searchParams.set('setlang', 'zh-CN')
  // 多取一些（Bing 每页约 10 条），便于过滤掉站内/广告链接后仍够数。
  url.searchParams.set('count', String(Math.min(20, Math.max(count + 5, 10))))

  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': WEB_SEARCH_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  })
  if (!res.ok) {
    throw new Error(`Bing 网页搜索 HTTP ${res.status}`)
  }
  // 带进度读取（结果页通常 ~100KB，给用户可见反馈）。
  const bytes = await readResponseWithProgress(res, {
    signal,
    label: 'Bing 网页',
    onProgress: onProgress ? (p) => onProgress(renderProgressBar(p, 'Bing 网页')) : undefined,
  })
  const html = new TextDecoder('utf-8').decode(bytes)
  return parseBingWebResults(html, count)
}

/**
 * 解析 Bing 网页搜索结果 HTML，提取标题/URL/摘要。
 * 抽取为独立函数便于单元测试与维护（结构变化时只改此处）。
 * @param html 搜索结果页 HTML。
 * @param count 需要的结果数上限。
 * @returns 结果列表（已过滤站内/广告链接、去重 URL）。
 */
export function parseBingWebResults(html: string, count: number): SearchResultItem[] {
  const items: SearchResultItem[] = []
  const seen = new Set<string>()
  const liRe = /<li class="b_algo"[\s\S]*?<\/li>/g
  let m: RegExpExecArray | null
  while ((m = liRe.exec(html)) !== null && items.length < count) {
    const block = m[0]
    // 标题：<h2 ...><a ... href="URL" ...>TITLE</a>（h2 可能带空 class，故用 [^>]*）。
    const a = /<h2[^>]*>\s*<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!a) continue
    const rawUrl = decodeHtmlEntities(a[1]).trim()
    // 仅保留真实外链，过滤 Bing 站内/跳转/广告链接。
    if (!/^https?:\/\//i.test(rawUrl) || /(^https?:\/\/)?([^/]*\.)?bing\.com\//i.test(rawUrl)) {
      continue
    }
    if (seen.has(rawUrl)) continue
    // 摘要：优先 b_caption 内的 <p>，否则任意 <p>。
    const p =
      /<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(block) ??
      /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
    seen.add(rawUrl)
    items.push({
      title: stripTags(a[2]) || '(无标题)',
      url: rawUrl,
      snippet: p ? stripTags(p[1]) : '',
    })
  }
  return items
}

/**
 * 去除 HTML 标签并清理常见实体/多余空白（用于网页结果的标题与摘要）。
 * @param s 含标签/实体的 HTML 片段。
 * @returns 干净纯文本。
 */
function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 解码常见 HTML 实体（含数字实体），覆盖 Bing 摘要里高频出现的 &ensp; &#0183; 等。
 * @param s 含实体的字符串。
 * @returns 解码后字符串。
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number.parseInt(d, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = Number.parseInt(h, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
}
