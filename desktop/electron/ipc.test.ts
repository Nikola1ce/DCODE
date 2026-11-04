// IPC 来源、参数、资源及 preload 白名单测试；仅用模拟传输，不加载 Electron。
// 制作人：Moriarty_Dox
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { installIpcRoutes } from './ipc.js'
import type { IpcController, IpcHandler } from './ipc.js'
import { createDesktopBridge } from './bridge.js'
import { CONTENT_SECURITY_POLICY, SECURE_WEB_PREFERENCES, isAllowedAssetUrl, isTrustedInvocation } from './windowSecurity.js'
import { CHANNELS } from '../shared/channels.js'
import { EMPTY_SNAPSHOT } from '../shared/api.js'
import type { DesktopEvent } from '../shared/api.js'

const url = 'file:///application/renderer/index.html'
function fixture() {
  const routes = new Map<string, IpcHandler>()
  const owner = { mainFrame: { url }, isDestroyed: () => false }
  const event = { sender: owner, senderFrame: owner.mainFrame }
  const controller: IpcController = {
    getSnapshot: vi.fn(() => EMPTY_SNAPSHOT), chooseWorkspace: vi.fn(async () => null),
    reconnect: vi.fn(async () => EMPTY_SNAPSHOT), sendPrompt: vi.fn(() => ({ requestId: 'turn-1' })),
    cancelTurn: vi.fn(async () => {}), respondPermission: vi.fn(),
  }
  const cleanup = installIpcRoutes({
    handle: (channel, handler) => { routes.set(channel, handler) },
    removeHandler: (channel) => { routes.delete(channel) },
  }, controller, (incoming) => isTrustedInvocation(incoming, owner, url))
  return { routes, event, owner, controller, cleanup }
}

describe('IPC 白名单与来源', () => {
  it('仅注册六个明确方法，不提供启动路径、文件、进程、配置或通用 send', () => {
    const f = fixture()
    expect([...f.routes.keys()].sort()).toEqual([
      CHANNELS.snapshot, CHANNELS.chooseWorkspace, CHANNELS.reconnect, CHANNELS.prompt, CHANNELS.cancel, CHANNELS.permission,
    ].sort())
    f.cleanup()
    expect(f.routes.size).toBe(0)
  })

  it('拒绝其他 WebContents、同 URL 子框架、空 frame、已销毁页面与导航后的页面', async () => {
    const f = fixture()
    for (const event of [
      { sender: {}, senderFrame: f.owner.mainFrame },
      { sender: f.owner, senderFrame: { url } },
      { sender: f.owner, senderFrame: null },
    ]) {
      expect(await f.routes.get(CHANNELS.chooseWorkspace)!(event)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    f.owner.mainFrame.url = 'https://untrusted.example/'
    expect(await f.routes.get(CHANNELS.snapshot)!(f.event)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    f.owner.mainFrame.url = url
    f.owner.isDestroyed = () => true
    expect(await f.routes.get(CHANNELS.snapshot)!(f.event)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(f.controller.chooseWorkspace).not.toHaveBeenCalled()
  })

  it('renderer 不能传路径/会话到 chooseWorkspace 或 reconnect', async () => {
    const f = fixture()
    for (const channel of [CHANNELS.chooseWorkspace, CHANNELS.reconnect, CHANNELS.cancel, CHANNELS.snapshot]) {
      for (const value of ['C:\\private', { cwd: '/private', sessionId: 'forged' }]) {
        expect(await f.routes.get(channel)!(f.event, value)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
      }
    }
    expect(f.controller.chooseWorkspace).not.toHaveBeenCalled()
    expect(f.controller.reconnect).not.toHaveBeenCalled()
    expect(await f.routes.get(CHANNELS.chooseWorkspace)!(f.event)).toEqual({ ok: true, value: null })
  })

  it.each([null, {}, '', '  ', '你'.repeat(22_000)])('拒绝不合法/超长 prompt', async (value) => {
    const f = fixture()
    expect(await f.routes.get(CHANNELS.prompt)!(f.event, value)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(f.controller.sendPrompt).not.toHaveBeenCalled()
  })

  it('不接受任意协议对象、额外字段、allow_always 或工具参数作为授权', async () => {
    const f = fixture()
    const route = f.routes.get(CHANNELS.permission)!
    for (const args of [
      [{ permissionId: 'p1', decision: 'allow_once' }],
      ['p1', 'allow_always'], ['../p1', 'allow_once'], ['p1', 'allow_once', { command: 'unsafe' }],
    ]) {
      expect(await route(f.event, ...args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    }
    expect(f.controller.respondPermission).not.toHaveBeenCalled()
    expect(await route(f.event, 'p1', 'allow_once')).toEqual({ ok: true, value: undefined })
    expect(f.controller.respondPermission).toHaveBeenCalledWith('p1', 'allow_once')
  })

  it('未知内部错误不将密钥/堆栈传回页面', async () => {
    const f = fixture()
    vi.mocked(f.controller.getSnapshot).mockImplementation(() => { throw new Error('apiKey=must-not-leak') })
    const result = await f.routes.get(CHANNELS.snapshot)!(f.event)
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
  })
})

describe('隔离 preload 与资源策略', () => {
  it('只暴露 typed 方法，订阅去除原生 event，unsubscribe 幂等且不影响其他订阅', () => {
    const handlers = new Set<(event: unknown, payload: DesktopEvent) => void>()
    const transport = {
      invoke: vi.fn(async () => ({ ok: true, value: undefined })),
      on: vi.fn((_channel, listener) => handlers.add(listener)),
      removeListener: vi.fn((_channel, listener) => handlers.delete(listener)),
    }
    const api = createDesktopBridge(transport)
    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.keys(api).sort()).toEqual(['getSnapshot', 'chooseWorkspace', 'reconnect', 'sendPrompt', 'cancelTurn', 'respondPermission', 'subscribe'].sort())
    const listener = vi.fn()
    const other = vi.fn()
    const unsubscribe = api.subscribe(listener)
    api.subscribe(other)
    const event: DesktopEvent = { type: 'connection', snapshot: EMPTY_SNAPSHOT }
    for (const handler of handlers) handler({ sender: 'native object' }, event)
    expect(listener).toHaveBeenCalledWith(event)
    expect(listener.mock.calls[0]).toHaveLength(1)
    unsubscribe()
    unsubscribe()
    for (const handler of handlers) handler({}, event)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(2)
    expect(transport.removeListener).toHaveBeenCalledTimes(1)
    void api.sendPrompt('hello')
    void api.respondPermission('p1', 'deny')
    expect(transport.invoke).toHaveBeenCalledWith(CHANNELS.prompt, 'hello')
    expect(transport.invoke).toHaveBeenCalledWith(CHANNELS.permission, 'p1', 'deny')
  })

  it('窗口隔离与 CSP 禁止 Node、远程执行和网络连接，资源必须精确匹配', async () => {
    expect(SECURE_WEB_PREFERENCES).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false })
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'none'")
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval/)
    const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8')
    expect(html).toContain(CONTENT_SECURITY_POLICY)
    const allowed = new Set([url, 'file:///application/renderer/index.js'])
    expect(isAllowedAssetUrl(url, allowed)).toBe(true)
    for (const target of ['https://example.com', 'file:///etc/passwd', `${url}?other`, `${url}#other`, 'javascript:alert(1)', 'data:text/html,unsafe']) {
      expect(isAllowedAssetUrl(target, allowed)).toBe(false)
    }
  })
})
