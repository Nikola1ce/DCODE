// web_fetch / web_search 工具单元测试。
// 使用 mock fetch 验证入参校验、权限与响应格式化，不依赖真实网络。
// 制作人：Moriarty_Dox

import { afterEach, describe, expect, it, vi } from 'vitest'
import { webFetchTool } from './webFetch.js'
import { resolveSearchApiKey, webSearchTool } from './webSearch.js'

const mockCtx = {
  cwd: process.cwd(),
  config: {} as any,
  permissionMode: 'bypass' as const,
  abortSignal: new AbortController().signal,
  requestPermission: async () => 'allow_once' as const,
  todos: [],
  setTodos: () => {},
}

describe('webFetchTool', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('拒绝 localhost URL', async () => {
    const result = await webFetchTool.run({ url: 'http://127.0.0.1/' }, mockCtx as any)
    expect(result.isError).toBe(true)
    expect(result.llmContent).toContain('禁止')
  })

  it('成功抓取 HTML 并提取正文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html><body><p>Fetch OK</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    )

    const result = await webFetchTool.run({ url: 'https://example.com/page' }, mockCtx as any)
    expect(result.isError).toBeFalsy()
    expect(result.llmContent).toContain('Fetch OK')
  })

  it('checkPermission 在非 bypass 时返回请求', () => {
    const req = webFetchTool.checkPermission?.(
      { url: 'https://example.com' },
      { ...mockCtx, permissionMode: 'default' } as any,
    )
    expect(req?.toolName).toBe('web_fetch')
  })
})

describe('webSearchTool', () => {
  const envBackup = { ...process.env }

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = { ...envBackup }
  })

  it('未配置 API Key 时返回错误', async () => {
    delete process.env.SERPAPI_API_KEY
    delete process.env.BING_SEARCH_API_KEY
    const result = await webSearchTool.run({ search_term: 'vitest' }, mockCtx as any)
    expect(result.isError).toBe(true)
    expect(result.llmContent).toContain('未配置')
  })

  it('resolveSearchApiKey 优先 SerpAPI', () => {
    process.env.SERPAPI_API_KEY = 'serp-key'
    process.env.BING_SEARCH_API_KEY = 'bing-key'
    expect(resolveSearchApiKey().provider).toBe('serpapi')
  })

  it('使用 Bing API 格式化搜索结果', async () => {
    process.env.BING_SEARCH_API_KEY = 'test-bing-key'
    delete process.env.SERPAPI_API_KEY

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          webPages: {
            value: [
              { name: 'Result A', url: 'https://a.test', snippet: 'Snippet A' },
            ],
          },
        }),
      ),
    )

    const result = await webSearchTool.run(
      { search_term: 'dcode cli', num_results: 3 },
      mockCtx as any,
    )
    expect(result.isError).toBeFalsy()
    expect(result.llmContent).toContain('Result A')
    expect(result.llmContent).toContain('https://a.test')
  })
})
