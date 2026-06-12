// web_search 工具。
// 通过 Bing Search API 或 SerpAPI 执行 Web 搜索；API Key 由环境变量配置。
// plan 模式下不可用；执行前需用户授权。
// 制作人：Moriarty_Dox

import {
  BING_SEARCH_ENDPOINT,
  ENV_BING_SEARCH_KEY,
  ENV_SERPAPI_KEY,
  PRODUCT_NAME,
  VERSION,
  WEB_SEARCH_TIMEOUT_MS,
} from '../constants.js'
import type { PermissionRequest, ToolDefinition, ToolResult } from '../core/types.js'

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
    '需配置环境变量 SERPAPI_API_KEY（SerpAPI）或 BING_SEARCH_API_KEY（Bing Web Search v7）。' +
    'plan 模式下不可用；执行前需用户授权。',
  readOnly: false,
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

    const { provider, apiKey } = resolveSearchApiKey()
    if (!provider || !apiKey) {
      return {
        llmContent:
          '错误：未配置搜索 API Key。\n' +
          `请设置环境变量 ${ENV_SERPAPI_KEY}（SerpAPI）或 ${ENV_BING_SEARCH_KEY}（Bing Search v7）。`,
        isError: true,
      }
    }

    const count = clampResults(input.num_results ?? 5)
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS)

    try {
      const items =
        provider === 'serpapi'
          ? await searchViaSerpApi(term, count, apiKey, controller.signal)
          : await searchViaBing(term, count, apiKey, controller.signal)

      if (items.length === 0) {
        return {
          llmContent: `未找到与「${term}」相关的搜索结果。`,
          uiSummary: 'web_search 无结果',
        }
      }

      const lines = items.map(
        (item, i) =>
          `${i + 1}. ${item.title}\n   URL: ${item.url}\n   ${item.snippet}`,
      )
      return {
        llmContent: `搜索「${term}」的结果（${provider}，${items.length} 条）：\n\n${lines.join('\n\n')}`,
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
 */
async function searchViaSerpApi(
  term: string,
  count: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<SearchResultItem[]> {
  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google')
  url.searchParams.set('q', term)
  url.searchParams.set('num', String(count))
  url.searchParams.set('api_key', apiKey)

  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': `${PRODUCT_NAME}/${VERSION}` },
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`SerpAPI HTTP ${res.status}: ${errText.slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    organic_results?: { title?: string; link?: string; snippet?: string }[]
  }
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
 */
async function searchViaBing(
  term: string,
  count: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<SearchResultItem[]> {
  const url = new URL(BING_SEARCH_ENDPOINT)
  url.searchParams.set('q', term)
  url.searchParams.set('count', String(count))
  url.searchParams.set('textFormat', 'Raw')

  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': `${PRODUCT_NAME}/${VERSION}`,
      'Ocp-Apim-Subscription-Key': apiKey,
    },
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Bing Search HTTP ${res.status}: ${errText.slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    webPages?: { value?: { name?: string; url?: string; snippet?: string }[] }
  }
  return (data.webPages?.value ?? []).slice(0, count).map((r) => ({
    title: r.name ?? '(无标题)',
    url: r.url ?? '',
    snippet: r.snippet ?? '',
  }))
}
