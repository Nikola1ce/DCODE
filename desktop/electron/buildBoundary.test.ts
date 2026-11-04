// 编译产物边界测试：协议 type import 被擦除，renderer 不包含内核/Node，preload 仅依赖 Electron。
// 制作人：Moriarty_Dox
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))

describe('浏览器与沙箱 preload 构建边界', () => {
  it('renderer 只包含 React、桌面页面和共享契约，不打包根协议或内核', async () => {
    const result = await build({
      absWorkingDir: root, entryPoints: ['src/index.tsx'], bundle: true, platform: 'browser',
      format: 'esm', outfile: 'dist/test-renderer.js', write: false, metafile: true,
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    })
    const inputs = Object.keys(result.metafile!.inputs).map((path) => path.replaceAll('\\', '/'))
    expect(inputs).toContain('shared/api.ts')
    expect(inputs.some((path) => path.startsWith('../') || path.startsWith('electron/'))).toBe(false)
    expect(inputs.some((path) => path.includes('src/ide/') || path.includes('src/core/') || path.includes('config.ts'))).toBe(false)
    const externalImports = Object.values(result.metafile!.outputs).flatMap((output) => output.imports.filter((entry) => entry.external))
    expect(externalImports).toEqual([])
  })

  it('preload 为自包含 CJS，外部模块只有 electron，不依赖原生 fs/子进程', async () => {
    const result = await build({
      absWorkingDir: root, entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node',
      format: 'cjs', outfile: 'dist/test-preload.cjs', write: false, metafile: true,
      external: ['electron'], logLevel: 'silent',
    })
    const inputs = Object.keys(result.metafile!.inputs).map((path) => path.replaceAll('\\', '/'))
    expect(inputs.sort()).toEqual(['electron/bridge.ts', 'electron/preload.ts', 'shared/channels.ts'])
    const externalImports = Object.values(result.metafile!.outputs).flatMap((output) => output.imports.filter((entry) => entry.external).map((entry) => entry.path))
    expect(externalImports).toEqual(['electron'])
    expect(result.outputFiles![0].text).not.toMatch(/require\(["'](?:node:)?(?:fs|child_process|path)/)
  })
})
