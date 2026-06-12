// 项目级配置信任标记。
// 项目 .dcode/ 下的 MCP、Hooks 等可执行配置默认不加载，除非用户显式信任该项目。
// 信任方式：在项目根创建 .dcode/trust 文件，或设置环境变量 DCODE_TRUST_PROJECT=1。
// 制作人：Moriarty_Dox

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 项目信任标记文件名（位于 <cwd>/.dcode/trust）。 */
export const PROJECT_TRUST_MARKER = 'trust'

/**
 * 判断当前工作目录的项目级配置（MCP/Hooks 等）是否已被用户信任。
 * @param cwd 工作目录绝对路径。
 * @returns 已信任返回 true。
 */
export function isProjectConfigTrusted(cwd: string): boolean {
  if (process.env.DCODE_TRUST_PROJECT === '1') return true
  return existsSync(join(cwd, '.dcode', PROJECT_TRUST_MARKER))
}
