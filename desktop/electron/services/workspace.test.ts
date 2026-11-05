// 临时目录验证忽略规则、有界预览、路径边界与监听清理。
// 制作人：Moriarty_Dox
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceService, workspacePath } from './workspace.js'

let root: string
let service: WorkspaceService
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dcode-files-')); service = new WorkspaceService() })
afterEach(async () => { service.dispose(); await rm(root, { recursive: true, force: true }) })

describe('工作区服务', () => {
  it('按目录优先排序并复用 .gitignore/.dcodeignore；监听忽略文件变化后重新读取规则', async () => {
    await mkdir(join(root, 'src'))
    await mkdir(join(root, '.git'))
    for (const file of ['a.txt', 'keep.log', 'hide.log']) await writeFile(join(root, file), '内容')
    await writeFile(join(root, '.gitignore'), '*.log\n')
    await writeFile(join(root, '.dcodeignore'), '!keep.log\n')
    const result = await service.list(root, '')
    expect(result.entries[0].path).toBe('src')
    expect(result.entries.map((entry) => entry.path)).toContain('keep.log')
    expect(result.entries.map((entry) => entry.path)).not.toContain('hide.log')
    expect(result.entries.map((entry) => entry.path)).not.toContain('.git')
    await writeFile(join(root, '.dcodeignore'), '!keep.log\n!hide.log\n')
    expect((await service.list(root, '')).entries.map((entry) => entry.path)).toContain('hide.log')
  })

  it.each(['../secret', '/secret', 'C:/secret', 'src/../secret', 'a\\b', 'x:stream', 'x\0', '.git/config', 'CON.txt', 'a./b'])('拒绝危险路径 %s', async (path) => {
    await expect(service.read(root, path)).rejects.toBeDefined()
  })

  it('拒绝外部 junction 以及被 junction 替换的父目录', async () => {
    await mkdir(join(root, 'project'))
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'secret.txt'), 'secret')
    await symlink(join(root, 'outside'), join(root, 'project', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.read(join(root, 'project'), 'link/secret.txt')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(workspacePath(join(root, 'project'), 'link/new.txt', true)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await service.list(join(root, 'project'), '')).entries).toEqual([])
  })

  it('UTF-8、空文件、二进制与截断的中文字符都有明确结果', async () => {
    await writeFile(join(root, 'text.txt'), '中文\r\n文本')
    await writeFile(join(root, 'empty.txt'), '')
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 255]))
    await writeFile(join(root, 'large.txt'), '你'.repeat(100_000))
    expect(await service.read(root, 'text.txt')).toMatchObject({ kind: 'text', text: '中文\r\n文本', truncated: false })
    expect(await service.read(root, 'empty.txt')).toMatchObject({ kind: 'text', text: '', size: 0 })
    expect(await service.read(root, 'binary.bin')).toMatchObject({ kind: 'binary', size: 3 })
    const large = await service.read(root, 'large.txt')
    expect(large).toMatchObject({ kind: 'text', truncated: true, size: 300_000 })
    if (large.kind === 'text') expect(large.text).toBe('你'.repeat(Math.floor(256 * 1024 / 3)))
  })

  it('监听合并刷新，dispose 取消待发事件并释放句柄', async () => {
    const changed = vi.fn()
    const failed = vi.fn()
    service.startWatch(root, changed, failed)
    await writeFile(join(root, 'new.txt'), '1')
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 3000 })
    service.dispose()
    changed.mockClear()
    await writeFile(join(root, 'new.txt'), '2')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(changed).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  })
})
