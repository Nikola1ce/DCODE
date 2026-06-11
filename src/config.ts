// DCODE 全局配置管理。
// 负责在用户主目录下读写 ~/.dcode/config.json，集中管理 API Key、默认模型、
// UI 主题、以及权限白名单（用户勾选过“总是允许”的工具规则）。
// 环境变量优先级高于配置文件，便于 CI / 临时覆盖。
// 制作人：Moriarty_Dox

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_MODEL,
} from './constants.js'

// UI 主题枚举：暗色 / 亮色。影响终端配色方案。
export type ThemeName = 'dark' | 'light'

// 权限模式：
// - default：写文件 / 执行命令前需用户确认；
// - acceptEdits：自动允许文件读写，命令仍需确认；
// - plan：只读规划模式，禁止任何写入/执行；
// - bypass：跳过所有确认（危险，谨慎使用）。
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

// 持久化到磁盘的配置结构。
export interface DCodeConfig {
  // DeepSeek API Key（敏感信息，仅存于用户本机）。
  apiKey?: string
  // API 基础地址，默认 DeepSeek 官方端点，可改为代理/中转。
  baseURL: string
  // 默认主对话模型。
  model: string
  // UI 主题。
  theme: ThemeName
  // 是否默认展示推理模型的思维链（reasoning_content）。
  showThinking: boolean
  // 全局“总是允许”的权限规则集合，形如 "Bash(git status)"、"Write" 等。
  alwaysAllow: string[]
  // 累计用量统计（成本、token），用于 /cost 展示历史总览。
  totalCostUsd: number
  // 是否已完成首次引导（用于决定是否展示新手提示）。
  onboardingComplete: boolean
}

// 配置默认值：首次运行或字段缺失时回退到这里。
const DEFAULT_CONFIG: DCodeConfig = {
  baseURL: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  theme: 'dark',
  showThinking: true,
  alwaysAllow: [],
  totalCostUsd: 0,
  onboardingComplete: false,
}

/**
 * 计算配置目录的绝对路径（~/.dcode）。
 * @returns 配置目录绝对路径字符串。
 */
export function getConfigDir(): string {
  return join(homedir(), CONFIG_DIR_NAME)
}

/**
 * 计算配置文件的绝对路径（~/.dcode/config.json）。
 * @returns 配置文件绝对路径字符串。
 */
export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE_NAME)
}

/**
 * 确保配置目录存在，不存在则递归创建。
 * 在写配置、写会话、写日志前调用，避免 ENOENT。
 */
export function ensureConfigDir(): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * 从磁盘读取配置并与默认值、环境变量合并。
 * 读取失败（文件损坏/不存在）时回退到默认配置，保证程序始终可启动。
 * @returns 合并后的完整配置对象。
 */
export function loadConfig(): DCodeConfig {
  let fileConfig: Partial<DCodeConfig> = {}
  const path = getConfigPath()
  if (existsSync(path)) {
    try {
      // 解析磁盘上的 JSON 配置；若损坏则忽略并使用默认值。
      fileConfig = JSON.parse(readFileSync(path, 'utf8')) as Partial<DCodeConfig>
    } catch {
      fileConfig = {}
    }
  }

  // 合并顺序：默认值 < 文件配置 < 环境变量。环境变量优先级最高。
  const merged: DCodeConfig = { ...DEFAULT_CONFIG, ...fileConfig }

  // 环境变量覆盖：便于在不写入磁盘的情况下临时指定密钥/端点/模型。
  if (process.env[ENV_API_KEY]) merged.apiKey = process.env[ENV_API_KEY]
  if (process.env[ENV_BASE_URL]) merged.baseURL = process.env[ENV_BASE_URL] as string
  if (process.env[ENV_MODEL]) merged.model = process.env[ENV_MODEL] as string

  return merged
}

/**
 * 将配置写回磁盘（~/.dcode/config.json）。
 * 注意：不会把通过环境变量临时注入的值额外清洗，调用方应传入期望持久化的完整对象。
 * @param config 待持久化的完整配置对象。
 */
export function saveConfig(config: DCodeConfig): void {
  ensureConfigDir()
  // 以 2 空格缩进美化输出，便于用户手动查看/编辑。
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8')
}

/**
 * 更新部分配置字段并立即持久化。
 * 先加载最新磁盘配置，合并补丁后写回，避免并发覆盖丢失字段。
 * @param patch 要更新的字段子集。
 * @returns 更新后的完整配置。
 */
export function updateConfig(patch: Partial<DCodeConfig>): DCodeConfig {
  const current = loadConfig()
  const next = { ...current, ...patch }
  saveConfig(next)
  return next
}

/**
 * 解析最终生效的 API Key：环境变量优先，其次配置文件。
 * @param config 已加载的配置对象。
 * @returns API Key 字符串；未配置则返回 undefined。
 */
export function resolveApiKey(config: DCodeConfig): string | undefined {
  return process.env[ENV_API_KEY] || config.apiKey
}
