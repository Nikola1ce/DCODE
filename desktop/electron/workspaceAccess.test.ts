// 原生授权能力、canonical 路径、内核资源位置和环境隔离测试。
// 制作人：Moriarty_Dox
import { resolve, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceAuthority, samePath } from './workspaceAccess.js'
import { coreCandidate, coreEnvironment, resolveCoreEntry } from './corePath.js'

const project = resolve('fixtures/real-project')
const link = resolve('fixtures/project-link')

describe('工作区路径授权', () => {
  it('原生选择后 realpath，授权只绑定 canonical 路径和主进程对象身份', async () => {
    const fs = { realpath: vi.fn(async () => project), isDirectory: vi.fn(async () => true) }
    const authority = new WorkspaceAuthority(fs)
    const grant = await authority.authorizeDialogSelection(link)
    expect(grant.cwd).toBe(project)
    expect(fs.realpath).toHaveBeenCalledWith(link)
    expect(Object.isFrozen(grant)).toBe(true)
    await authority.validate(grant)
    expect(fs.realpath).toHaveBeenLastCalledWith(project)
    await expect(authority.validate({ ...grant })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    authority.revoke(grant)
    await expect(authority.validate(grant)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it.each(['../project', 'project', 'bad\0path'])('拒绝相对路径与控制字符 %s', async (path) => {
    const authority = new WorkspaceAuthority({ realpath: async () => project, isDirectory: async () => true })
    await expect(authority.authorizeDialogSelection(path)).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' })
  })

  it('拒绝不可访问路径与文件，不授予工作区能力', async () => {
    const unreadable = new WorkspaceAuthority({ realpath: async () => { throw new Error('denied') }, isDirectory: async () => true })
    await expect(unreadable.authorizeDialogSelection(link)).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' })
    const file = new WorkspaceAuthority({ realpath: async () => project, isDirectory: async () => false })
    await expect(file.authorizeDialogSelection(link)).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' })
  })

  it('启动前重验：canonical 路径被替换为指向其他目录的链接时拒绝', async () => {
    let target = project
    const authority = new WorkspaceAuthority({ realpath: async () => target, isDirectory: async () => true })
    const grant = await authority.authorizeDialogSelection(link)
    target = resolve('private')
    await expect(authority.validate(grant)).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' })
  })

  it('clear 撤销全部工作区身份；Windows 路径按大小写不敏感比较', async () => {
    const authority = new WorkspaceAuthority({ realpath: async () => project, isDirectory: async () => true })
    const grant = await authority.authorizeDialogSelection(link)
    authority.clear()
    await expect(authority.validate(grant)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(samePath(project, project.toUpperCase(), 'win32')).toBe(true)
    expect(samePath(project, `${project}-other`, 'win32')).toBe(false)
  })
})

describe('内核资源路径', () => {
  const repoRoot = resolve('repo')
  const resourcesPath = resolve('app/resources')
  it('开发默认根 dist，打包默认资源 core/cli.mjs，覆盖仅限主进程环境', () => {
    expect(coreCandidate({ packaged: false, repoRoot, resourcesPath, env: {} })).toBe(join(repoRoot, 'dist', 'cli.js'))
    expect(coreCandidate({ packaged: true, repoRoot, resourcesPath, env: {} })).toBe(join(resourcesPath, 'core', 'cli.mjs'))
    const override = resolve('alternate/cli.js')
    expect(coreCandidate({ packaged: true, repoRoot, resourcesPath, env: { DCODE_DESKTOP_CORE_PATH: override } })).toBe(override)
    const customResources = resolve('alternate/resources')
    expect(coreCandidate({ packaged: true, repoRoot, resourcesPath, env: { DCODE_DESKTOP_RESOURCES_PATH: customResources } })).toBe(join(customResources, 'core', 'cli.mjs'))
  })

  it('拒绝相对入口/资源路径，缺失内核返回可识别错误', async () => {
    expect(() => coreCandidate({ packaged: false, repoRoot, resourcesPath, env: { DCODE_DESKTOP_CORE_PATH: '../cli.js' } })).toThrowError(expect.objectContaining({ code: 'CORE_NOT_FOUND' }))
    expect(() => coreCandidate({ packaged: true, repoRoot, resourcesPath, env: { DCODE_DESKTOP_RESOURCES_PATH: '../resources' } })).toThrowError(expect.objectContaining({ code: 'CORE_NOT_FOUND' }))
    await expect(resolveCoreEntry({ packaged: false, repoRoot: resolve('missing-core-fixture'), resourcesPath, env: {} })).rejects.toMatchObject({ code: 'CORE_NOT_FOUND' })
  })

  it('保留内核所需环境，但移除 Node 注入参数并强制 Electron Node 模式', () => {
    const env = { PATH: 'system', Node_Options: '--require bad', NODE_PATH: 'bad', ELECTRON_RUN_AS_NODE: '0', OPENAI_API_KEY: 'secret' }
    expect(coreEnvironment(env)).toEqual({ PATH: 'system', ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'secret' })
    expect(env.ELECTRON_RUN_AS_NODE).toBe('0')
  })
})
