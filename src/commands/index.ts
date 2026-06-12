// 斜杠命令系统。
// 解析并执行以 "/" 开头的本地命令（不发送给模型），如 /help、/model、/cost、/init、/clear 等。
// 命令通过 SlashCommandResult 把“要展示的信息 / 要触发的 UI 流程 / 要代为提交的 prompt”
// 返回给上层 UI 处理，从而与 Agent、配置、界面解耦。
// 制作人：Moriarty_Dox

import { PRODUCT_NAME, AUTHOR, VERSION, SUPPORTED_MODELS, REASONING_EFFORTS, isSupportedModelName, isValidReasoningEffort } from '../constants.js'
import type { DCodeConfig, PermissionMode } from '../config.js'
import { updateConfig } from '../config.js'
import type { Agent } from '../core/agent.js'
import { formatCost } from '../deepseek/pricing.js'
import { getProjectMemoryPath, hasProjectMemory } from '../memory.js'
import { ALL_TOOLS } from '../tools/index.js'

// 命令可触发的特殊 UI 交互流程类型。
export type SpecialFlow = 'model' | 'login' | 'resume' | 'theme'

// 命令执行结果。
export interface SlashCommandResult {
  // 要作为系统消息展示的文本（可选）。
  message?: string
  // 是否清空了会话（UI 据此清屏）。
  cleared?: boolean
  // 要打开的特殊交互流程（如模型选择器）。
  openFlow?: SpecialFlow
  // 要代替用户提交给 Agent 的 prompt（如 /init 生成记忆文件）。
  submitPrompt?: string
  // 是否请求退出程序。
  exit?: boolean
}

// 命令运行上下文。
export interface SlashCommandContext {
  // 当前 Agent 实例。
  agent: Agent
  // 当前配置。
  config: DCodeConfig
  // 持久化并刷新配置的回调（写盘 + 更新内存中的 config 引用）。
  applyConfig: (patch: Partial<DCodeConfig>) => void
  // 命令参数（命令名之后的剩余文本，已去除首尾空白）。
  args: string
}

// 单个斜杠命令定义。
export interface SlashCommand {
  // 主名称（不含前导 /）。
  name: string
  // 命令说明（用于 /help）。
  description: string
  // 别名列表。
  aliases?: string[]
  // 执行逻辑。
  run: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>
}

// 全部内置命令定义。
export const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: '显示所有可用命令与简要用法',
    aliases: ['?', 'h'],
    run: () => ({ message: renderHelp() }),
  },
  {
    name: 'about',
    description: `关于 ${PRODUCT_NAME}（版本与制作人信息）`,
    run: () => ({ message: renderAbout() }),
  },
  {
    name: 'model',
    description: '查看或切换模型，例如 /model deepseek-v4-pro',
    run: (ctx) => {
      const target = ctx.args.trim()
      // 无参数：打开模型选择器。
      if (!target) return { openFlow: 'model' }
      // 校验模型名是否受支持。
      if (!isSupportedModelName(target)) {
        return {
          message: `不支持的模型：${target}\n可用模型：${SUPPORTED_MODELS.join('、')}`,
        }
      }
      ctx.agent.setModel(target)
      ctx.applyConfig({ model: target })
      return { message: `已切换模型为 ${target}` }
    },
  },
  {
    name: 'cost',
    description: '显示本次会话的 token 用量与预估成本',
    run: (ctx) => ({ message: renderCost(ctx.agent) }),
  },
  {
    name: 'clear',
    description: '清空当前对话历史（保留系统设定），开始新话题',
    aliases: ['new'],
    run: (ctx) => {
      ctx.agent.clear()
      return { message: '已清空对话历史。', cleared: true }
    },
  },
  {
    name: 'compact',
    description: '立即压缩上下文，释放空间但保留关键信息',
    run: async (ctx) => {
      const msg = await ctx.agent.compactNow()
      return { message: msg }
    },
  },
  {
    name: 'init',
    description: '分析当前项目并生成/更新 DCODE.md 记忆文件',
    run: (ctx) => {
      const exists = hasProjectMemory(ctx.agent.cwd)
      const path = getProjectMemoryPath(ctx.agent.cwd)
      // 通过给 Agent 下达一条指令，让其借助工具完成分析与写文件。
      const prompt =
        `请分析当前项目并${exists ? '更新' : '创建'}记忆文件 ${path}（DCODE.md）。` +
        '步骤：1) 用 list_dir/glob/read_file 了解项目结构、技术栈、关键脚本（如 package.json 的 scripts）；' +
        '2) 用 write_file 写入一个 Markdown 文件，包含：项目简介、技术栈、目录结构要点、常用命令（构建/测试/运行）、' +
        '代码风格与约定、注意事项。内容用简体中文，简洁实用。'
      return {
        message: `开始${exists ? '更新' : '生成'}项目记忆文件 ${path} ...`,
        submitPrompt: prompt,
      }
    },
  },
  {
    name: 'login',
    description: '设置或更新 DeepSeek API Key',
    aliases: ['key'],
    run: () => ({ openFlow: 'login' }),
  },
  {
    name: 'resume',
    description: '从历史会话列表中恢复一个会话',
    run: () => ({ openFlow: 'resume' }),
  },
  {
    name: 'theme',
    description: '切换界面主题（暗色/亮色）',
    run: () => ({ openFlow: 'theme' }),
  },
  {
    name: 'thinking',
    description: '开关思维链(reasoning_content)的展示',
    run: (ctx) => {
      const next = !ctx.config.showThinking
      ctx.applyConfig({ showThinking: next })
      return { message: `思维链展示已${next ? '开启' : '关闭'}。` }
    },
  },
  {
    name: 'effort',
    description: '查看或切换推理强度：high | max（Thinking 模式下生效，Pro 复杂任务推荐 max）',
    aliases: ['reasoning-effort'],
    run: (ctx) => {
      const target = ctx.args.trim().toLowerCase()
      if (!target) {
        return {
          message:
            `当前推理强度：${ctx.config.reasoningEffort}\n` +
            `可选：${REASONING_EFFORTS.join('、')}（例如 /effort max）\n` +
            '说明：仅在 Thinking 模式启用时传给 API；/thinking 关闭时不发送 reasoning_effort。',
        }
      }
      if (!isValidReasoningEffort(target)) {
        return {
          message: `无效的推理强度：${target}\n可用：${REASONING_EFFORTS.join('、')}`,
        }
      }
      ctx.applyConfig({ reasoningEffort: target })
      return { message: `已切换推理强度为 ${target}。` }
    },
  },
  {
    name: 'mode',
    description: '查看或切换权限模式：plan | auto | bypass',
    run: (ctx) => {
      const target = ctx.args.trim()
      const valid = ['plan', 'auto', 'bypass'] as const
      if (!target) {
        return {
          message: `当前权限模式：${formatUserMode(ctx.agent.permissionMode)}（${describeMode(ctx.agent.permissionMode)}）\n可切换为：${valid.join('、')}（例如 /mode plan）`,
        }
      }
      const mode = parseUserMode(target)
      if (!mode) {
        return { message: `无效的权限模式：${target}\n可用：${valid.join('、')}` }
      }
      ctx.agent.setPermissionMode(mode)
      return {
        message: `已切换权限模式为 ${formatUserMode(mode)}（${describeMode(mode)}）`,
      }
    },
  },
  {
    name: 'plan',
    description: '快捷进入「规划模式」（只读，不修改文件/不执行命令）',
    run: (ctx) => {
      ctx.agent.setPermissionMode('plan')
      return { message: '已进入规划模式：仅阅读与分析，不会修改文件或执行命令。' }
    },
  },
  {
    name: 'auto',
    description: '快捷进入「自动接受编辑」模式（文件读写免确认）',
    run: (ctx) => {
      ctx.agent.setPermissionMode('acceptEdits')
      return { message: '已进入自动接受编辑模式：文件读写免确认，命令仍需授权。' }
    },
  },
  {
    name: 'bypass',
    description: '快捷进入「跳过确认」模式（所有操作免确认，危险）',
    run: (ctx) => {
      ctx.agent.setPermissionMode('bypass')
      return {
        message:
          '已进入跳过确认模式：文件读写与命令执行均不再请求授权。请谨慎使用，避免不可逆的破坏性操作。',
      }
    },
  },
  {
    name: 'memory',
    description: '显示当前加载的项目/全局记忆文件路径',
    run: (ctx) => {
      const path = getProjectMemoryPath(ctx.agent.cwd)
      const exists = hasProjectMemory(ctx.agent.cwd)
      return {
        message: exists
          ? `项目记忆文件：${path}（已加载）`
          : `当前项目尚无 DCODE.md。可执行 /init 自动生成。`,
      }
    },
  },
  {
    name: 'config',
    description: '显示当前配置（隐藏密钥）',
    run: (ctx) => ({ message: renderConfig(ctx.config) }),
  },
  {
    name: 'exit',
    description: '退出 DCODE',
    aliases: ['quit', 'q'],
    run: () => ({ exit: true }),
  },
]

// 命令名/别名 -> 命令 的索引。
const COMMAND_MAP = new Map<string, SlashCommand>()
for (const cmd of COMMANDS) {
  COMMAND_MAP.set(cmd.name, cmd)
  for (const alias of cmd.aliases ?? []) COMMAND_MAP.set(alias, cmd)
}

/**
 * 判断一行输入是否为斜杠命令。
 * @param input 用户输入。
 * @returns 以 / 开头返回 true。
 */
export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith('/')
}

// 命令建议项：供输入框自动补全菜单展示的轻量结构（不含执行逻辑）。
export interface CommandSuggestion {
  // 命令主名称（不含前导 /）。
  name: string
  // 命令说明（与 /help 中一致）。
  description: string
  // 命令别名列表（可选，用于提示）。
  aliases?: string[]
}

/**
 * 根据用户在 "/" 之后输入的前缀，过滤出匹配的命令建议列表。
 * 匹配规则：命令主名或任一别名以该前缀开头（不区分大小写）；
 * 前缀为空（刚输入 "/"）时返回全部命令。供 InputPrompt 的命令补全菜单使用。
 * @param query "/" 之后、空格之前的查询文本（不含 /）。
 * @returns 匹配的命令建议数组，保持 COMMANDS 的定义顺序。
 */
export function filterCommands(query: string): CommandSuggestion[] {
  const q = query.trim().toLowerCase()
  return COMMANDS.filter((cmd) => {
    // 空前缀返回全部，便于刚输入 "/" 时展示完整命令清单。
    if (q === '') return true
    // 主名前缀匹配。
    if (cmd.name.toLowerCase().startsWith(q)) return true
    // 别名前缀匹配。
    return (cmd.aliases ?? []).some((a) => a.toLowerCase().startsWith(q))
  }).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    aliases: cmd.aliases,
  }))
}

/**
 * 解析并执行斜杠命令。
 * @param input 用户输入（含前导 /）。
 * @param ctx 命令运行上下文。
 * @returns 执行结果；命令不存在时返回提示信息。
 */
export async function runSlashCommand(
  input: string,
  ctx: Omit<SlashCommandContext, 'args'>,
): Promise<SlashCommandResult> {
  const trimmed = input.trim().slice(1) // 去掉前导 /
  const spaceIdx = trimmed.indexOf(' ')
  const name = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

  const cmd = COMMAND_MAP.get(name)
  if (!cmd) {
    return {
      message: `未知命令：/${name}\n输入 /help 查看所有命令。`,
    }
  }
  return await cmd.run({ ...ctx, args })
}

/**
 * 渲染 /help 文本。
 * @returns 命令列表说明。
 */
function renderHelp(): string {
  const lines = COMMANDS.map((c) => {
    const aliases = c.aliases?.length ? `（别名：${c.aliases.map((a) => '/' + a).join(' ')}）` : ''
    return `  /${c.name.padEnd(10)} ${c.description}${aliases}`
  })
  return [
    `${PRODUCT_NAME} 可用命令：`,
    ...lines,
    '',
    '直接输入文字即可与助手对话；按 Esc 可中断正在进行的回答。',
  ].join('\n')
}

/**
 * 渲染 /about 文本（含制作人署名）。
 * @returns 关于信息。
 */
function renderAbout(): string {
  return [
    `${PRODUCT_NAME}  v${VERSION}`,
    `适配 DeepSeek 模型的命令行 AI 编程助手`,
    `制作人：${AUTHOR}`,
    '',
    `内置工具：${ALL_TOOLS.map((t) => t.name).join('、')}`,
  ].join('\n')
}

/**
 * 渲染 /cost 文本。
 * @param agent 当前 Agent。
 * @returns 用量与成本信息。
 */
function renderCost(agent: Agent): string {
  const u = agent.usage
  return [
    '本次会话用量统计：',
    `  输入 token：${u.inputTokens}（其中缓存命中 ${u.cacheHitTokens}）`,
    `  输出 token：${u.outputTokens}`,
    `  预估成本：${formatCost(u.costUsd)}`,
  ].join('\n')
}

/**
 * 渲染 /config 文本（隐藏密钥）。
 * @param config 当前配置。
 * @returns 配置信息。
 */
function renderConfig(config: DCodeConfig): string {
  const masked = config.apiKey
    ? config.apiKey.slice(0, 4) + '****' + config.apiKey.slice(-2)
    : '(未设置)'
  return [
    '当前配置：',
    `  模型：${config.model}`,
    `  API 端点：${config.baseURL}`,
    `  API Key：${masked}`,
    `  主题：${config.theme}`,
    `  思维链展示：${config.showThinking ? '开' : '关'}`,
    `  推理强度：${config.reasoningEffort}（Thinking 模式下生效）`,
  ].join('\n')
}

/**
 * 将用户输入的模式名解析为内部 PermissionMode。
 * @param input 用户输入（plan / auto / bypass，兼容 acceptEdits）。
 * @returns 内部模式，无法识别时返回 null。
 */
function parseUserMode(input: string): PermissionMode | null {
  switch (input.trim()) {
    case 'plan':
      return 'plan'
    case 'auto':
    case 'acceptEdits':
      return 'acceptEdits'
    case 'bypass':
      return 'bypass'
    default:
      return null
  }
}

/**
 * 将内部权限模式映射为用户可见名称。
 * @param mode 内部权限模式。
 * @returns plan / auto / bypass；默认启动态显示 default。
 */
function formatUserMode(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'plan'
    case 'acceptEdits':
      return 'auto'
    case 'bypass':
      return 'bypass'
    default:
      return 'default'
  }
}

/**
 * 返回权限模式的中文说明。
 * @param mode 权限模式。
 * @returns 说明文本。
 */
function describeMode(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return '只读规划'
    case 'acceptEdits':
      return '自动接受编辑'
    case 'bypass':
      return '跳过所有确认'
    default:
      return '默认，写操作需确认'
  }
}
