// DCODE 构建脚本：使用 esbuild 将 src/cli.tsx 及其全部依赖打包为单文件 dist/cli.js。
// 设计目标：产出一个带 shebang、可直接执行的 ESM 单文件 CLI，便于 npm link / 全局安装后运行。
// 制作人：Moriarty_Dox

import { build, context } from 'esbuild'
import { chmodSync, cpSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// 计算项目根目录（本文件所在目录），用于拼接入口与产物的绝对路径。
const __dirname = dirname(fileURLToPath(import.meta.url))

// 输出文件路径：dist/cli.js。
const outfile = resolve(__dirname, 'dist/cli.js')

/**
 * 复制运行时静态资源到 dist。
 * esbuild 只打包 JS，二进制资源（提示音 WAV）需手动随产物复制：
 * assets/ -> dist/assets/，使运行期可通过 cli.js 同级的 assets/sounds 定位音效文件。
 */
function copyAssets() {
  const srcAssets = resolve(__dirname, 'assets')
  const destAssets = resolve(__dirname, 'dist/assets')
  if (existsSync(srcAssets)) {
    cpSync(srcAssets, destAssets, { recursive: true })
    console.log('[DCODE] 已复制静态资源 ->', destAssets)
  }
}

// 是否处于 watch（监听）模式，便于本地开发时自动重建。
const isWatch = process.argv.includes('--watch')

/**
 * 公共的 esbuild 配置。
 * - bundle：把 react/ink/openai 等依赖一并打进单文件，安装后无需 node_modules 即可运行。
 * - platform=node + format=esm：以 Node ESM 形式输出。
 * - banner：注入 shebang，并用 createRequire 兼容被打包进来的 CJS 依赖中残留的 require 调用。
 */
const options = {
  entryPoints: [resolve(__dirname, 'src/cli.tsx')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  jsx: 'automatic',
  // 一些可选原生依赖（如 sharp/fsevents）在本项目用不到，标记为 external 避免打包报错。
  external: ['fsevents', 'sharp'],
  // 用空 stub 替换 ink 仅在 DEV 模式才动态加载的 react-devtools-core，避免无谓依赖。
  alias: {
    'react-devtools-core': resolve(__dirname, 'build-stubs/react-devtools-core.js'),
  },
  banner: {
    js: [
      '#!/usr/bin/env node',
      // 为 ESM 产物补充 require / __dirname / __filename，兼容部分依赖的 CJS 写法。
      "import { createRequire as __dcodeCreateRequire } from 'module';",
      "import { fileURLToPath as __dcodeFileURLToPath } from 'url';",
      "import { dirname as __dcodeDirname } from 'path';",
      'const require = __dcodeCreateRequire(import.meta.url);',
      'const __filename = __dcodeFileURLToPath(import.meta.url);',
      'const __dirname = __dcodeDirname(__filename);',
      // 关闭 Node 弃用警告（如依赖内部使用 punycode 触发的 DEP0040），保持终端输出干净。
      'try { process.noDeprecation = true; } catch {}',
    ].join('\n'),
  },
  logLevel: 'info',
  // 保留函数名，方便运行期错误栈与中文注释定位。
  keepNames: true,
}

/**
 * 主构建流程：watch 模式下持续监听，否则单次构建并赋予可执行权限。
 */
async function run() {
  if (isWatch) {
    // 监听模式：源码改动后自动重建，便于开发调试。先复制一次资源，保证开发期也能定位音效。
    copyAssets()
    const ctx = await context(options)
    await ctx.watch()
    console.log('[DCODE] 正在监听源码变更（watch 模式）...')
  } else {
    // 单次构建：完成后给产物加上可执行权限（Windows 下该调用无副作用）。
    await build(options)
    // 复制静态资源（提示音 WAV 等）到 dist/assets。
    copyAssets()
    try {
      chmodSync(outfile, 0o755)
    } catch {
      // 某些平台（如 Windows）chmod 不生效，忽略即可。
    }
    console.log('[DCODE] 构建完成 ->', outfile)
  }
}

run().catch((err) => {
  console.error('[DCODE] 构建失败：', err)
  process.exit(1)
})
