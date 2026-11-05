// 设置读写与失败恢复均使用临时目录，禁止触碰真实用户配置。
// 制作人：Moriarty_Dox
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename) }
})
import { SettingsService } from './settings.js'

let root: string
let settings: SettingsService
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dcode-settings-')); settings = new SettingsService(root) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('桌面设置', () => {
  it('最近项目持久化、去重排序并限制为十二项', async () => {
    expect(await settings.recentWorkspaces()).toEqual([])
    for (let index = 0; index < 14; index++) await settings.rememberWorkspace(join(root, `project-${index}`))
    const recent = await settings.recentWorkspaces()
    expect(recent).toHaveLength(12)
    const previous = recent[4]
    await settings.rememberWorkspace(previous.path)
    const reloaded = new SettingsService(root)
    expect((await reloaded.recentWorkspaces())[0]).toMatchObject({ id: previous.id, path: previous.path })
    expect(new Set((await reloaded.recentWorkspaces()).map((item) => item.path)).size).toBe(12)
  })
  it('默认值、并发字段更新、会话元信息合并与写前备份', async () => {
    expect(await settings.get()).toMatchObject({ theme: 'system', sendKey: 'enter', notifications: true, preventSleep: true, closeBehavior: 'ask' })
    await Promise.all([
      settings.update({ theme: 'dark' }), settings.update({ notifications: false }),
      settings.updateSession('session-1', { title: '标题', pinned: true }),
    ])
    expect(await settings.get()).toMatchObject({ theme: 'dark', notifications: false })
    expect((await settings.presentations())['session-1']).toEqual({ title: '标题', pinned: true })
    const backup = JSON.parse(await readFile(`${settings.path}.bak`, 'utf8'))
    expect(backup.preferences).toMatchObject({ theme: 'dark', notifications: false })
    expect(backup.sessions).toBeUndefined()
  })

  it('保留磁盘未知字段，仅把展示偏好交给 renderer', async () => {
    await writeFile(settings.path, JSON.stringify({ version: 1, future: { data: 'keep' }, preferences: { theme: 'light', private: 'hidden' } }))
    await settings.update({ sendKey: 'mod-enter' })
    const value = JSON.parse(await readFile(settings.path, 'utf8'))
    expect(value.future).toEqual({ data: 'keep' })
    expect(value.preferences.private).toBe('hidden')
    expect(await settings.get()).not.toHaveProperty('private')
  })

  it('损坏文件与未来版本拒绝覆盖', async () => {
    for (const original of ['{bad', '{"version":2}', '{"version":1,"preferences":{"theme":"oops"}}', '{"version":1,"preferences":false}']) {
      await writeFile(settings.path, original)
      await expect(settings.update({ theme: 'dark' })).rejects.toMatchObject({ code: 'SETTINGS_INVALID' })
      expect(await readFile(settings.path, 'utf8')).toBe(original)
    }
  })

  it('原子替换失败后保留原文，队列可继续接受重试', async () => {
    await settings.update({ theme: 'light' })
    const original = await readFile(settings.path, 'utf8')
    vi.mocked(rename).mockRejectedValueOnce(new Error('disk full'))
    await expect(settings.update({ theme: 'dark' })).rejects.toThrow('disk full')
    expect(await readFile(settings.path, 'utf8')).toBe(original)
    await settings.update({ theme: 'dark' })
    expect(await settings.get()).toMatchObject({ theme: 'dark' })
  })

  it.each([{ apiKey: 'secret' }, { theme: 'unknown' }, { notifications: 1 }, { closeBehavior: 'hide' }, { notifyError: 1 }, [], null, JSON.parse('{"__proto__":{}}')])('拒绝未知或畸形更新 %j', async (patch) => {
    await expect(settings.update(patch)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('旧偏好补齐系统默认值，落盘后通知订阅者并支持解除订阅', async () => {
    await writeFile(settings.path, JSON.stringify({ version: 1, preferences: { theme: 'light' } }))
    expect(await settings.get()).toMatchObject({ theme: 'light', closeBehavior: 'ask', notifyError: true })
    const listener = vi.fn()
    const unsubscribe = settings.subscribe(listener)
    const result = await settings.update({ closeBehavior: 'tray', notifyComplete: false })
    expect(listener).toHaveBeenCalledWith(result)
    await expect(new SettingsService(root).get()).resolves.toMatchObject({ closeBehavior: 'tray', notifyComplete: false })
    unsubscribe()
    await settings.update({ closeBehavior: 'quit' })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
