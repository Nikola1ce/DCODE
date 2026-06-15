#!/usr/bin/env node
/**
 * Release 打包脚本：构建 dist/cli.js，组装免命令安装包并输出 ZIP。
 * 用法：npm run package
 * 产出：release/out/DCODE-v{version}-portable.zip
 * 制作人：Moriarty_Dox
 */

import { build } from 'esbuild'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const templatesDir = join(root, 'release', 'templates')
const outRoot = join(root, 'release', 'out')

/**
 * 读取 package.json 中的版本号。
 * @returns 语义化版本字符串
 */
function readVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return pkg.version
}

/**
 * 与 build.mjs 一致的 esbuild 配置。
 * @param outfile 输出 cli.js 路径
 * @returns esbuild 配置对象
 */
function getBuildOptions(outfile) {
  return {
    entryPoints: [join(root, 'src/cli.tsx')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    jsx: 'automatic',
    external: ['fsevents', 'sharp'],
    alias: {
      'react-devtools-core': join(root, 'build-stubs/react-devtools-core.js'),
    },
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __dcodeCreateRequire } from 'module';",
        "import { fileURLToPath as __dcodeFileURLToPath } from 'url';",
        "import { dirname as __dcodeDirname } from 'path';",
        'const require = __dcodeCreateRequire(import.meta.url);',
        'const __filename = __dcodeFileURLToPath(import.meta.url);',
        'const __dirname = __dcodeDirname(__filename);',
        'try { process.noDeprecation = true; } catch {}',
      ].join('\n'),
    },
    logLevel: 'info',
    keepNames: true,
  }
}

/**
 * 将 release/templates 内文件复制到 staging 根目录。
 * @param staging 临时打包目录
 */
function copyTemplates(staging) {
  for (const name of readdirSync(templatesDir)) {
    const src = join(templatesDir, name)
    const dest = join(staging, name)
    if (statSync(src).isDirectory()) {
      cpSync(src, dest, { recursive: true })
    } else {
      copyFileSync(src, dest)
    }
  }
  copyFileSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))
  try {
    chmodSync(join(staging, 'dcode.sh'), 0o755)
  } catch {
    // Windows 上 chmod 可能无效，忽略
  }
}

/**
 * 生成 ZIP 压缩包。
 * @param staging 源目录
 * @param zipPath 输出路径
 */
function createZip(staging, zipPath) {
  mkdirSync(dirname(zipPath), { recursive: true })
  if (process.platform === 'win32') {
    const srcGlob = join(staging, '*').replace(/'/g, "''")
    const dest = zipPath.replace(/'/g, "''")
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${srcGlob}' -DestinationPath '${dest}' -Force"`,
      { stdio: 'inherit' },
    )
  } else {
    execSync(`cd "${staging}" && zip -r "${zipPath}" .`, { stdio: 'inherit' })
  }
}

/** 主流程：构建、组装、压缩。 */
async function main() {
  const version = readVersion()
  const zipName = `DCODE-v${version}-portable.zip`
  const staging = join(outRoot, `DCODE-v${version}`)
  const zipPath = join(outRoot, zipName)

  console.log(`[DCODE] 开始打包 Release v${version} ...`)

  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(staging, 'dist'), { recursive: true })

  const outfile = join(staging, 'dist', 'cli.js')
  await build(getBuildOptions(outfile))
  try {
    chmodSync(outfile, 0o755)
  } catch {}

  // 复制运行时静态资源（提示音 WAV）到 staging 的 dist/assets，使打包产物自带音效文件。
  const srcAssets = join(root, 'assets')
  if (existsSync(srcAssets)) {
    cpSync(srcAssets, join(staging, 'dist', 'assets'), { recursive: true })
    console.log('[DCODE] 已复制静态资源 -> dist/assets')
  }

  copyTemplates(staging)
  writeFileSync(join(staging, 'VERSION.txt'), `DCODE v${version}\n`, 'utf8')

  rmSync(zipPath, { force: true })
  createZip(staging, zipPath)

  console.log('[DCODE] 打包完成：')
  console.log(`  目录：${staging}`)
  console.log(`  ZIP ：${zipPath}`)
}

main().catch((err) => {
  console.error('[DCODE] 打包失败：', err)
  process.exit(1)
})
