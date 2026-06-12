/**
 * 演示脚本：模拟 /proxy + /provider openai，将 OpenAI 配置写入 ~/.dcode/config.json。
 * 供桌面 CMD 演示可见输出；API Key 优先读 OPENAI_API_KEY 环境变量。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.dcode')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')
const PROXY = process.env.DCODE_PROXY || process.env.HTTPS_PROXY || 'http://127.0.0.1:10793'
const API_KEY = process.env.OPENAI_API_KEY?.trim()

console.log('')
console.log('>>> 模拟命令: /proxy ' + PROXY)
console.log('>>> 模拟命令: /provider openai')
console.log('')

let config = {}
if (existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    config = {}
  }
}

config.provider = 'openai'
config.baseURL = 'https://api.openai.com/v1'
config.model = 'gpt-4o-mini'
config.proxy = PROXY

if (API_KEY) {
  console.log('>>> 模拟输入 OpenAI Key: ' + API_KEY.slice(0, 8) + '****' + API_KEY.slice(-4))
  config.providers = {
    ...(config.providers || {}),
    openai: {
      ...(config.providers?.openai || {}),
      apiKey: API_KEY,
      defaultModel: 'gpt-4o-mini',
    },
  }
} else {
  console.log('>>> [警告] 未设置 OPENAI_API_KEY，请在 CMD 中: set OPENAI_API_KEY=sk-...')
}

if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')

console.log('')
console.log('已写入配置: ' + CONFIG_PATH)
console.log('  Provider : openai')
console.log('  模型     : gpt-4o-mini')
console.log('  端点     : https://api.openai.com/v1')
console.log('  代理     : ' + PROXY)
console.log('  Key      : ' + (API_KEY ? '(已配置)' : '(未配置)'))
console.log('')
