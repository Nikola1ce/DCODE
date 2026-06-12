// 子进程环境变量净化。
// Shell / Hooks 子进程不应继承完整 process.env，避免恶意命令读取 API Key 等敏感变量。
// 制作人：Moriarty_Dox

/** 匹配常见 API Key / 密钥类环境变量名（子串不区分大小写）。 */
const SENSITIVE_ENV_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /^DEEPSEEK_/i,
  /^ZHIPU_/i,
  /^OPENAI_/i,
  /^SERPAPI_/i,
  /^BING_SEARCH_/i,
  /^DCODE_API_KEY$/i,
  /^ANTHROPIC_/i,
]

/**
 * 判断环境变量名是否可能携带密钥，不应传给 Agent 启动的子进程。
 * @param name 环境变量名。
 * @returns 敏感返回 true。
 */
function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some((re) => re.test(name))
}

/**
 * 构建供 run_command / 后台 Shell 使用的净化环境变量。
 * 保留 PATH、系统 locale、HOME 等非密钥变量，剔除 API Key 等。
 * @returns 净化后的 env 对象。
 */
export function createSafeChildEnv(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (isSensitiveEnvName(key)) continue
    safe[key] = value
  }
  return safe
}
