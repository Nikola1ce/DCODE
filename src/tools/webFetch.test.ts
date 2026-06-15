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

  it('拒绝重定向到内网', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.redirect('http://127.0.0.1/secret', 302),
      ),
    )

    const result = await webFetchTool.run({ url: 'https://example.com/redirect' }, mockCtx as any)
    expect(result.isError).toBe(true)
    expect(result.llmContent).toMatch(/禁止|内网|127/)
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

  it('ruleKey 为工具级（不含域名）：总是允许一次后对所有网站生效', () => {
    const reqA = webFetchTool.checkPermission?.(
      { url: 'https://a.example.com/x' },
      { ...mockCtx, permissionMode: 'default' } as any,
    )
    const reqB = webFetchTool.checkPermission?.(
      { url: 'https://b.other.org/y' },
      { ...mockCtx, permissionMode: 'default' } as any,
    )
    // 不同域名应得到相同的工具级 ruleKey，从而共享同一条「总是允许」白名单。
    expect(reqA?.ruleKey).toBe('web_fetch')
    expect(reqB?.ruleKey).toBe('web_fetch')
    // 但 title 仍分别展示各自域名，便于用户辨认访问目标。
    expect(reqA?.title).toContain('a.example.com')
    expect(reqB?.title).toContain('b.other.org')
  })

  it('bypass 模式不请求授权', () => {
    const req = webFetchTool.checkPermission?.(
      { url: 'https://example.com' },
      { ...mockCtx, permissionMode: 'bypass' } as any,
    )
    expect(req).toBeNull()
  })
})

describe('webSearchTool', () => {
  const envBackup = { ...process.env }

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = { ...envBackup }
  })

  it('未配置 API Key 时回退「零 Key」Bing 网页后端（不报未配置）', async () => {
    // 产品设计：无任何搜索 Key 时应开箱即用，回退抓取 cn.bing.com 网页结果，而非报错。
    delete process.env.SERPAPI_API_KEY
    delete process.env.BING_SEARCH_API_KEY
    // mock 一个最小可解析的 Bing 网页结果（<li class="b_algo"> 内含标题与摘要）。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          `<html><body>
            <li class="b_algo"><h2><a href="https://result.test">网页标题</a></h2>
            <div class="b_caption"><p>网页摘要内容</p></div></li>
          </body></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
      ),
    )
    const result = await webSearchTool.run({ search_term: 'vitest' }, mockCtx as any)
    // 关键：不应再误报「未配置」。
    expect(result.llmContent).not.toContain('未配置')
    // 能解析出结果则更佳（解析容错，至少不应是错误结果）。
    expect(result.isError).toBeFalsy()
    expect(result.llmContent).toContain('网页标题')
  })

  it('resolveSearchApiKey 优先 SerpAPI', () => {
    process.env.SERPAPI_API_KEY = 'serp-key'
    process.env.BING_SEARCH_API_KEY = 'bing-key'
    expect(resolveSearchApiKey().provider).toBe('serpapi')
  })

  it('使用 SerpAPI GET 参数格式化搜索结果', async () => {
    process.env.SERPAPI_API_KEY = 'test-serp-key'
    delete process.env.BING_SEARCH_API_KEY

    let seenUrl = ''
    let seenInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        seenUrl = input instanceof URL ? input.toString() : String(input)
        seenInit = init
        return Response.json({
          organic_results: [
            { title: 'Serp Result', link: 'https://serp.test', snippet: 'Serp Snippet' },
          ],
        })
      }),
    )

    const result = await webSearchTool.run(
      { search_term: 'dcode cli', num_results: 2 },
      mockCtx as any,
    )
    expect(result.isError).toBeFalsy()
    expect(result.llmContent).toContain('Serp Result')
    expect(seenUrl).toContain('https://serpapi.com/search.json?')
    expect(seenUrl).toContain('engine=google')
    expect(seenUrl).toContain('q=dcode+cli')
    expect(seenUrl).toContain('num=2')
    expect(seenUrl).toContain('api_key=test-serp-key')
    expect(seenInit?.method).toBeUndefined()
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
