// 独立 esbuild 构建；renderer 安全边界检查，不启动 GUI，也不构建/改写根项目。
// 制作人：Moriarty_Dox
import * as esbuild from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')
await mkdir(join(root, 'dist/renderer'), { recursive: true })
await copyFile(join(root, 'src/index.html'), join(root, 'dist/renderer/index.html'))

const rendererBoundary = {
  name: 'renderer-boundary',
  setup(build) {
    build.onEnd((result) => {
      const forbidden = Object.keys(result.metafile?.inputs ?? {}).filter((file) => {
        const absolute = resolve(root, file).replaceAll('\\', '/')
        return absolute.startsWith(resolve(root, '../src').replaceAll('\\', '/') + '/')
          || absolute.includes('/electron/')
      })
      if (forbidden.length) return { errors: [{ text: `renderer 包含非浏览器源码：${forbidden.join(', ')}` }] }
    })
  },
}
const common = {
  absWorkingDir: root, bundle: true, sourcemap: 'external', logLevel: 'info',
  legalComments: 'none', metafile: true,
}
const configs = [
  {
    ...common, entryPoints: ['electron/main.ts'], outfile: 'dist/electron/main.cjs',
    platform: 'node', format: 'cjs', target: 'node22', external: ['electron'],
  },
  {
    ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist/electron/preload.cjs',
    platform: 'node', format: 'cjs', target: 'es2022', external: ['electron'],
  },
  {
    ...common, entryPoints: ['src/index.tsx'], outfile: 'dist/renderer/index.js',
    platform: 'browser', format: 'esm', target: 'chrome134',
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
    minify: !watch, plugins: [rendererBoundary],
  },
]
if (watch) {
  const contexts = await Promise.all(configs.map((config) => esbuild.context(config)))
  await Promise.all(contexts.map((context) => context.watch()))
  console.log('桌面源码监听中。另开终端在 desktop/ 运行 npm start；主进程/preload 变更需重启窗口。')
  const stop = async () => {
    await Promise.all(contexts.map((context) => context.dispose()))
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)))
}
