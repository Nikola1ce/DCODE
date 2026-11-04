// 主进程专用的内核入口解析：开发用根 dist/cli.js，打包用 resources/core/cli.mjs。
// 制作人：Moriarty_Dox
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DesktopFault } from './errors.js'

export interface CoreLocation {
  packaged: boolean
  repoRoot: string
  resourcesPath: string
  env: NodeJS.ProcessEnv
}

/** 路径覆盖仅来自启动 Electron 的本地环境，不接受 IPC 输入。 */
export function coreCandidate(options: CoreLocation): string {
  const override = options.env.DCODE_DESKTOP_CORE_PATH
  const resources = options.env.DCODE_DESKTOP_RESOURCES_PATH ?? options.resourcesPath
  if ((override && (!isAbsolute(override) || override.includes('\0')))
    || (options.env.DCODE_DESKTOP_RESOURCES_PATH && (!isAbsolute(resources) || resources.includes('\0')))) {
    throw new DesktopFault('CORE_NOT_FOUND', '内核入口和资源目录配置必须为绝对路径。')
  }
  return override ?? (options.packaged ? join(resources, 'core', 'cli.mjs') : join(options.repoRoot, 'dist', 'cli.js'))
}

export async function resolveCoreEntry(options: CoreLocation): Promise<string> {
  const candidate = coreCandidate(options)
  try {
    const file = await realpath(candidate)
    if (!/\.(?:m?js|cjs)$/i.test(file) || !(await stat(file)).isFile()) throw new Error('entry')
    return file
  } catch {
    throw new DesktopFault('CORE_NOT_FOUND', '找不到内核入口。开发时请先在仓库根目录运行 npm run build；打包时请提供 resources/core/cli.mjs。')
  }
}

/** 不继承会改变 Node 加载行为的注入参数；API Key 仅留在内核环境，不进入 IPC。 */
export function coreEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env }
  for (const key of Object.keys(result)) {
    if (['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) delete result[key]
  }
  result.ELECTRON_RUN_AS_NODE = '1'
  return result
}
