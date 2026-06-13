// DCODE VS Code 扩展构建脚本。
// 用 esbuild 把 src/extension.ts 及其依赖打包为单文件 dist/extension.js（CommonJS）。
// 关键点：vscode 模块由编辑器宿主在运行期注入，必须标记为 external，不能打进产物。
// 制作人：Moriarty_Dox

import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// 当前脚本所在目录（扩展子项目根）。
const __dirname = dirname(fileURLToPath(import.meta.url))

// 是否监听模式（本地开发用，源码改动后自动重建）。
const isWatch = process.argv.includes('--watch')
// 是否生产构建（发布 .vsix 时启用压缩、去除 sourcemap）。
const isProduction = process.argv.includes('--production')

/**
 * esbuild 公共配置。
 * - platform=node + format=cjs：VS Code 扩展宿主以 CommonJS 加载 main 入口；
 * - external: ['vscode']：vscode API 由宿主提供，严禁打包；
 * - 产物落在 dist/extension.js，与 package.json 的 main 字段一致。
 */
const options = {
  entryPoints: [resolve(__dirname, 'src/extension.ts')],
  outfile: resolve(__dirname, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
  keepNames: true,
}

/**
 * 主构建流程：watch 模式持续监听，否则单次构建。
 */
async function run() {
  if (isWatch) {
    const ctx = await context(options)
    await ctx.watch()
    console.log('[DCODE-VSCode] 正在监听源码变更（watch 模式）...')
  } else {
    await build(options)
    console.log('[DCODE-VSCode] 构建完成 -> dist/extension.js')
  }
}

run().catch((err) => {
  console.error('[DCODE-VSCode] 构建失败：', err)
  process.exit(1)
})
