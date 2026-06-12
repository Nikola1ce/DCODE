// 斜杠命令系统。
// 解析并执行以 "/" 开头的本地命令（不发送给模型），如 /help、/model、/cost、/init、/clear 等。
// 命令通过 SlashCommandResult 把“要展示的信息 / 要触发的 UI 流程 / 要代为提交的 prompt”
// 返回给上层 UI 处理，从而与 Agent、配置、界面解耦。
// 制作人：Moriarty_Dox

import { PRODUCT_NAME, AUTHOR, VERSION, SUPPORTED_MODELS, REASONING_EFFORTS, isSupportedModelName, isValidReasoningEffort } from '../constants.js'
import { join } from 'node:path'
import type { DCodeConfig, PermissionMode } from '../config.js'
import { updateConfig, resolveApiKey } from '../config.js'
import type { Agent } from '../core/agent.js'
import { renderSubAgentsStatus } from '../core/subAgent.js'
import { renderShellsStatus } from '../core/shellManager.js'
import { getHookManager, renderHooksStatus } from '../core/hooks.js'
import {
  isValidSkillName,
  renderSkillList,
  getProjectSkillsDir,
} from '../core/skills.js'
import {
  clearCheckpoints,
  renderCheckpointList,
  undoCheckpoints,
  renderUndoResult,
} from '../core/checkpoint.js'
import {
  buildCommitAgentPrompt,
  buildPrAgentPrompt,
  renderGitStatusReport,
} from '../core/gitUtils.js'
import {
  checkForUpdate,
  renderUpdateStatus,
  runUpdate,
} from '../core/updater.js'
import { getMcpManager, type MCPManager } from '../mcp/client.js'
import { getGlobalMcpConfigPath } from '../mcp/config.js'
import { formatCost } from '../deepseek/pricing.js'
import { getProjectMemoryPath, hasProjectMemory } from '../memory.js'
import { ALL_TOOLS } from '../tools/index.js'
import { globalToolRegistry } from '../tools/registry.js'
import {
  buildProviderSwitchPatch,
  getActiveProviderId,
  getProviderDefinition,
  getSuggestedModelsForProvider,
  isModelAllowedForProvider,
  isValidProviderId,
  PROVIDER_COMMAND_NAME,
  PROVIDER_SWITCH_OPTIONS,
  renderProviderList,
  renderProviderStatus,
  resolveProviderApiKey,
} from '../providers/registry.js'
import {
  formatProxyDisplay,
  isForeignProvider,
  renderProxyHint,
  resolveProviderProxy,
} from '../providers/proxy.js'
import type { ProviderId } from '../providers/types.js'
import { isZhipuFreeModel, ZHIPU_FREE_MODEL_BADGE } from '../providers/zhipuModels.js'

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
      const providerId = getActiveProviderId(ctx.config)
      // DeepSeek 仍校验内置模型列表；其它 Provider 允许 OpenAI 兼容模型名。
      if (!isModelAllowedForProvider(target, ctx.config)) {
        if (providerId === 'deepseek') {
          return {
            message: `不支持的模型：${target}\n可用模型：${getSuggestedModelsForProvider(ctx.config).join('、')}`,
          }
        }
        const def = getProviderDefinition(providerId)
        const suggested = def.suggestedModels?.join('、') ?? '任意 OpenAI 兼容模型名'
        return {
          message: `无效的模型名：${target}\n当前 Provider (${def.name}) 建议：${suggested}`,
        }
      }
      ctx.agent.setModel(target)
      ctx.applyConfig({ model: target })
      return { message: `已切换模型为 ${target}` }
    },
  },
  {
    name: 'provider',
    description: '查看或切换 LLM Provider（zhipu / deepseek / openai）',
    aliases: ['providers'],
    run: (ctx) => {
      const target = ctx.args.trim().toLowerCase()
      if (!target) {
        return { message: renderProviderStatus(ctx.config) }
      }
      if (target === 'list') {
        return { message: renderProviderList(ctx.config) }
      }
      if (!isValidProviderId(target)) {
        return {
          message: `未知 Provider：${target}\n\n${renderProviderList(ctx.config)}`,
        }
      }
      if (target === 'ollama' || target === 'custom') {
        return {
          message:
            (target === 'ollama'
              ? 'Ollama 供应商已暂时下线。'
              : '自定义 Provider 暂不在切换列表中。') +
            '\n请使用 /provider zhipu、/provider openai 或 /provider deepseek。\n\n' +
            renderProviderList(ctx.config),
        }
      }
      if (!PROVIDER_SWITCH_OPTIONS.some((o) => o.id === target)) {
        return {
          message: `暂不支持切换至：${target}\n\n${renderProviderList(ctx.config)}`,
        }
      }
      const patch = buildProviderSwitchPatch(ctx.config, target as ProviderId)
      ctx.applyConfig(patch)
      const merged = { ...ctx.config, ...patch }
      const def = getProviderDefinition(target as ProviderId)
      const modelNote =
        patch.model && patch.model !== ctx.config.model
          ? `\n模型已自动切换为：${patch.model}`
          : ''
      const key = resolveProviderApiKey(merged)
      const keyNote = key
        ? `\n已加载 ${def.name} API Key。`
        : `\n⚠ 尚未配置 ${def.name} Key，请执行 /login。`
      return {
        message:
          `已切换 Provider 为 ${def.name} (${target})${modelNote}${keyNote}\n\n` +
          renderProviderStatus(merged),
      }
    },
  },
  {
    name: 'proxy',
    description: '查看或设置 HTTP(S) 代理（外国 Provider 如 OpenAI 需配置）',
    run: (ctx) => {
      const target = ctx.args.trim()
      if (!target) {
        const id = getActiveProviderId(ctx.config)
        const proxy = resolveProviderProxy(ctx.config, id)
        const lines = [
          `当前代理：${formatProxyDisplay(proxy)}`,
          renderProxyHint(ctx.config),
          '',
          '设置：/proxy http://127.0.0.1:10793',
          '清除配置：/proxy clear（环境变量仍生效）',
          '环境变量：DCODE_PROXY、HTTPS_PROXY、HTTP_PROXY',
        ]
        return { message: lines.join('\n') }
      }
      if (target.toLowerCase() === 'clear') {
        ctx.applyConfig({ proxy: undefined })
        return {
          message:
            '已清除 ~/.dcode/config.json 中的 proxy 字段。\n' +
            '若设置了环境变量 HTTPS_PROXY/DCODE_PROXY，仍会生效。',
        }
      }
      if (!/^https?:\/\/.+/i.test(target)) {
        return {
          message:
            '代理地址需以 http:// 或 https:// 开头。\n' +
            '示例：/proxy http://127.0.0.1:10793',
        }
      }
      ctx.applyConfig({ proxy: target })
      const id = getActiveProviderId(ctx.config)
      const foreignNote = isForeignProvider({ ...ctx.config, proxy: target }, id)
        ? '\n外国 Provider 请求将通过此代理发出。'
        : ''
      return {
        message: `已设置代理：${target}${foreignNote}\n\n${renderProxyHint({ ...ctx.config, proxy: target })}`,
      }
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
    description: '设置或更新当前 Provider 的 API Key（随 /provider 切换）',
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
    name: 'mcp',
    description: '查看或管理 MCP Server（list / resources / prompts / reload）',
    run: async (ctx) => {
      const mgr = getMcpManager()
      if (!mgr) {
        return { message: 'MCP 未初始化。' }
      }
      const sub = ctx.args.trim().toLowerCase()
      if (sub === 'reload') {
        await mgr.reload(ctx.agent.cwd)
        return {
          message: `${renderMcpStatus(mgr)}\n\n已重新加载 MCP 连接与工具注册表。`,
        }
      }
      if (sub === 'list') {
        return { message: renderMcpToolsList(mgr) }
      }
      if (sub === 'resources') {
        return { message: renderMcpResourcesList(mgr) }
      }
      if (sub === 'prompts') {
        return { message: renderMcpPromptsList(mgr) }
      }
      return { message: renderMcpStatus(mgr) }
    },
  },
  {
    name: 'subagents',
    description: '查看子代理（Task 工具）运行状态与历史',
    aliases: ['agents'],
    run: () => ({ message: renderSubAgentsStatus() }),
  },
  {
    name: 'shells',
    description: '查看后台 Shell（run_command background）运行状态',
    aliases: ['bg'],
    run: () => ({ message: renderShellsStatus() }),
  },
  {
    name: 'hooks',
    description: '查看或重载 Hooks 钩子（reload）',
    run: async (ctx) => {
      const mgr = getHookManager()
      if (!mgr) {
        return { message: 'Hooks 未初始化。' }
      }
      const sub = ctx.args.trim().toLowerCase()
      if (sub === 'reload') {
        mgr.reload(ctx.agent.cwd)
        return {
          message: `${renderHooksStatus(mgr)}\n\n已重新加载 Hooks 配置。`,
        }
      }
      return { message: renderHooksStatus(mgr) }
    },
  },
  {
    name: 'skills',
    description: '查看可用技能包列表',
    run: (ctx) => ({
      message: renderSkillList(ctx.agent.cwd, ctx.agent.getActiveSkillNames()),
    }),
  },
  {
    name: 'skill',
    description: '管理技能包：<名称> 加载 / unload / create',
    run: (ctx) => {
      const raw = ctx.args.trim()
      const spaceIdx = raw.indexOf(' ')
      const sub = (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).toLowerCase()
      const rest = spaceIdx === -1 ? '' : raw.slice(spaceIdx + 1).trim()

      // 无参数：提示使用 /skills 查看列表。
      if (!sub) {
        return {
          message:
            '用法：/skills 查看可用技能列表\n' +
            '      /skill <名称> 加载 | /skill unload <名称> 卸载 | /skill create <名称> 创建',
        }
      }

      // list：与 /skills 相同（兼容旧用法）。
      if (sub === 'list') {
        return {
          message: renderSkillList(ctx.agent.cwd, ctx.agent.getActiveSkillNames()),
        }
      }

      // active：仅显示已加载。
      if (sub === 'active' || sub === 'loaded') {
        const names = ctx.agent.getActiveSkillNames()
        if (names.length === 0) {
          return { message: '当前会话未加载任何技能。使用 /skill <名称> 加载。' }
        }
        const skills = ctx.agent.getActiveSkills()
        const lines = skills.map((s) => `  • ${s.name} — ${s.description}`)
        return { message: `已加载技能（${names.length}）：\n${lines.join('\n')}` }
      }

      // unload / off：卸载技能。
      if (sub === 'unload' || sub === 'off' || sub === 'remove') {
        if (!rest) {
          return { message: '用法：/skill unload <名称>' }
        }
        const result = ctx.agent.unloadSkill(rest)
        return { message: result.message }
      }

      // create：从当前对话摘要创建技能文件。
      if (sub === 'create' || sub === 'new') {
        if (!rest) {
          return { message: '用法：/skill create <名称>\n名称仅允许字母、数字、_、-' }
        }
        if (!isValidSkillName(rest)) {
          return {
            message: `无效的技能名：${rest}\n仅允许字母、数字、下划线与连字符，最长 64 字符。`,
          }
        }
        const outPath = joinSkillPath(ctx.agent.cwd, rest)
        const prompt =
          `请根据当前对话中的工作流与约定，创建技能文件 ${outPath}。\n` +
          '格式要求：\n' +
          '1) YAML frontmatter：name、description\n' +
          '2) 正文为 Markdown，说明何时触发、步骤、约束与输出格式\n' +
          '3) 使用 write_file 写入，内容简洁可复用，简体中文\n' +
          `4) 技能名必须为 ${rest}`
        return {
          message: `开始创建技能「${rest}」→ ${outPath}`,
          submitPrompt: prompt,
        }
      }

      // 默认：按名称加载技能。
      const result = ctx.agent.loadSkill(sub)
      return { message: result.message }
    },
  },
  {
    name: 'checkpoints',
    description: '查看文件检查点列表（write/edit 自动备份）',
    aliases: ['cp-list'],
    run: (ctx) => {
      const sub = ctx.args.trim().toLowerCase()
      if (sub === 'clear') {
        const n = clearCheckpoints(ctx.agent.cwd)
        return { message: n > 0 ? `已清理 ${n} 个检查点及备份文件。` : '没有可清理的检查点。' }
      }
      return { message: renderCheckpointList(ctx.agent.cwd) }
    },
  },
  {
    name: 'undo',
    description: '回退最近 N 个文件检查点（默认 1）',
    run: (ctx) => {
      const arg = ctx.args.trim()
      if (arg.toLowerCase() === 'clear') {
        const n = clearCheckpoints(ctx.agent.cwd)
        return { message: n > 0 ? `已清理 ${n} 个检查点及备份文件。` : '没有可清理的检查点。' }
      }
      const n = arg ? parseInt(arg, 10) : 1
      if (!Number.isFinite(n) || n < 1) {
        return { message: '用法：/undo [N]（默认 1）\n      /undo clear 或 /checkpoints clear 清空备份' }
      }
      const result = undoCheckpoints(ctx.agent.cwd, n)
      return { message: renderUndoResult(result) }
    },
  },
  {
    name: 'commit',
    description: '根据 staged 变更生成 Conventional Commits 并提交（需确认）',
    run: (ctx) => {
      const sub = ctx.args.trim().toLowerCase()
      if (sub === 'status') {
        return { message: renderGitStatusReport(ctx.agent.cwd) }
      }
      const built = buildCommitAgentPrompt(ctx.agent.cwd)
      if (!built.ok) {
        return { message: built.error }
      }
      return {
        message: `开始分析已暂存变更并生成 commit message…\n\n${built.summary}`,
        submitPrompt: built.prompt,
      }
    },
  },
  {
    name: 'pr',
    description: '生成 PR 标题与描述（/pr create 可尝试 gh pr create）',
    run: (ctx) => {
      const raw = ctx.args.trim()
      if (!raw || raw.toLowerCase() === 'status') {
        return { message: renderGitStatusReport(ctx.agent.cwd) }
      }

      let baseBranch: string | undefined
      let wantCreate = false

      if (raw.toLowerCase() === 'create') {
        wantCreate = true
      } else if (raw.toLowerCase().startsWith('create ')) {
        wantCreate = true
        baseBranch = raw.slice('create'.length).trim() || undefined
      } else {
        baseBranch = raw
      }

      const built = buildPrAgentPrompt(ctx.agent.cwd, baseBranch, wantCreate)
      if (!built.ok) {
        return { message: built.error }
      }
      return {
        message: `开始生成 Pull Request 描述…\n\n${built.summary}`,
        submitPrompt: built.prompt,
      }
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
    name: 'update',
    description: '检测并更新 DCODE（git pull + npm install + build，或 npm update -g）',
    aliases: ['upgrade'],
    run: async (ctx) => {
      const sub = ctx.args.trim().toLowerCase()
      if (!sub || sub === 'check' || sub === 'status') {
        const force = sub === 'check'
        const check = await checkForUpdate({ forceRefresh: force })
        return { message: renderUpdateStatus(check) }
      }
      if (sub === 'run' || sub === 'install' || sub === 'force') {
        const result = await runUpdate({ force: sub === 'force' })
        return { message: result.message }
      }
      return {
        message:
          '用法：/update | /update check | /update run | /update force\n' +
          '  check — 强制检测 GitHub 最新版本\n' +
          '  run   — 有新版本时执行更新\n' +
          '  force — 忽略版本比较，重新执行更新步骤',
      }
    },
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
  // 展示用短标签（命令名或参数名）。
  name: string
  // 命令说明（与 /help 中一致）。
  description: string
  // 补全/回车时写入的完整斜杠命令（含前导 /）。
  completion: string
  // 命令别名列表（可选，用于提示）。
  aliases?: string[]
}

/**
 * 为已选命令生成参数补全候选。
 * @param cmdName 命令主名。
 * @param argPrefix 空格后的参数前缀（小写）。
 * @returns 参数级建议；无参数补全则返回空数组。
 */
function getCommandArgSuggestions(
  cmdName: string,
  argPrefix: string,
  config?: DCodeConfig,
): CommandSuggestion[] {
  const q = argPrefix.trim().toLowerCase()

  if (cmdName === 'provider') {
    const options = [
      ...PROVIDER_SWITCH_OPTIONS.map((o) => ({
        name: o.id,
        description: o.description,
      })),
      { name: 'list', description: '列出全部 Provider' },
    ]
    return options
      .filter((o) => q === '' || o.name.startsWith(q))
      .map((o) => ({
        name: o.name,
        description: o.description,
        completion: `/provider ${o.name}`,
      }))
  }

  if (cmdName === 'model') {
    const models = config ? getSuggestedModelsForProvider(config) : [...SUPPORTED_MODELS]
    const providerId = config ? getActiveProviderId(config) : 'deepseek'
    return models.filter((m) => q === '' || m.toLowerCase().startsWith(q)).map((m) => {
      const isFree = providerId === 'zhipu' && isZhipuFreeModel(m)
      return {
        name: isFree ? `★ ${m}` : m,
        description: isFree ? ZHIPU_FREE_MODEL_BADGE : '切换模型',
        completion: `/model ${m}`,
      }
    })
  }

  return []
}

/**
 * 将 Provider 子选项插入到 /provider 命令项之后。
 * @param commandItems 已匹配的顶层命令建议。
 * @param args Provider 参数级建议。
 * @returns 合并后的建议列表。
 */
function appendProviderArgSuggestions(
  commandItems: CommandSuggestion[],
  args: CommandSuggestion[],
): CommandSuggestion[] {
  if (args.length === 0) return commandItems
  const idx = commandItems.findIndex((c) => c.completion === '/provider')
  if (idx >= 0) {
    return [...commandItems.slice(0, idx + 1), ...args, ...commandItems.slice(idx + 1)]
  }
  return [...commandItems, ...args]
}

/**
 * 过滤与 query 前缀匹配的顶层斜杠命令。
 * @param q 命令名查询（小写，不含 /）。
 * @returns 命令建议列表。
 */
function matchingCommandSuggestions(q: string): CommandSuggestion[] {
  return COMMANDS.filter((cmd) => {
    if (q === '') return true
    if (cmd.name.toLowerCase().startsWith(q)) return true
    return (cmd.aliases ?? []).some((a) => a.toLowerCase().startsWith(q))
  }).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    completion: `/${cmd.name}`,
    aliases: cmd.aliases,
  }))
}

/**
 * 根据当前输入生成斜杠命令补全候选（含命令名与部分命令的参数补全）。
 * @param input 输入框完整内容（可含前导 /）。
 * @returns 建议列表。
 */
export function getSlashSuggestions(input: string, config?: DCodeConfig): CommandSuggestion[] {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) return []

  const body = trimmed.slice(1)
  const spaceIdx = body.indexOf(' ')

  // 仍在输入命令名阶段（尚无空格）。
  if (spaceIdx === -1) {
    const q = body.toLowerCase()
    const commandItems = matchingCommandSuggestions(q)
    const providerArgs = getCommandArgSuggestions('provider', '', config)

    // 仅输入 /：全部命令 + 最底层 Provider 子选项。
    if (q === '') {
      return providerArgs.length > 0 ? [...commandItems, ...providerArgs] : commandItems
    }

    // 输入 /p … /provider 前缀：保留 plan/proxy/provider 等命令，并在 /provider 后追加子选项。
    if (PROVIDER_COMMAND_NAME.startsWith(q)) {
      return appendProviderArgSuggestions(commandItems, providerArgs)
    }

    // 其它命令完整匹配：展示参数子选项（如 /model）。
    const exact = COMMANDS.find(
      (cmd) =>
        cmd.name.toLowerCase() === q ||
        (cmd.aliases ?? []).some((a) => a.toLowerCase() === q),
    )
    if (exact && exact.name !== 'provider') {
      const args = getCommandArgSuggestions(exact.name, '', config)
      if (args.length > 0) return args
    }

    return commandItems
  }

  // 命令名之后正在输入参数。
  const cmdName = body.slice(0, spaceIdx).toLowerCase()
  const argPrefix = body.slice(spaceIdx + 1)
  const cmd = COMMAND_MAP.get(cmdName)
  if (!cmd) return []
  return getCommandArgSuggestions(cmd.name, argPrefix, config)
}

/**
 * 根据用户在 "/" 之后输入的前缀，过滤出匹配的命令建议列表。
 * @deprecated 请使用 getSlashSuggestions；保留供旧调用方兼容。
 * @param query "/" 之后、空格之前的查询文本（不含 /）。
 * @returns 匹配的命令建议数组。
 */
export function filterCommands(query: string): CommandSuggestion[] {
  return getSlashSuggestions(`/${query}`)
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
  const mcpCount = globalToolRegistry.mcpCount
  return [
    `${PRODUCT_NAME}  v${VERSION}`,
    `适配 DeepSeek 模型的DCode AI 助手`,
    `制作人：${AUTHOR}`,
    '',
    `内置工具：${ALL_TOOLS.filter((t) => !t.name.startsWith('mcp__')).map((t) => t.name).join('、')}`,
    mcpCount > 0
      ? `MCP 动态工具：${mcpCount} 个（/mcp list 查看）`
      : 'MCP：未连接 Server（配置 ~/.dcode/mcp.json 后 /mcp reload）',
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
    `  Provider / 模型：${agent.getProviderId()} / ${agent.getModel()}`,
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
  const key = resolveApiKey(config)
  const masked = key
    ? key === 'ollama'
      ? '(本地无需 Key)'
      : key.slice(0, 4) + '****' + key.slice(-2)
    : '(未设置)'
  const def = getProviderDefinition(getActiveProviderId(config))
  return [
    '当前配置：',
    `  Provider：${def.name} (${config.provider ?? 'zhipu'})`,
    `  模型：${config.model}`,
    `  API 端点：${config.baseURL}`,
    `  API Key：${masked}`,
    `  主题：${config.theme}`,
    `  思维链展示：${config.showThinking ? '开' : '关'}`,
    `  推理强度：${config.reasoningEffort}（${def.supportsThinking ? 'Thinking 模式下生效' : '当前 Provider 不支持'}）`,
    `  Hooks：${config.hooksEnabled !== false ? '启用' : '禁用'}`,
    renderProxyHint(config),
    '',
    '切换 Provider：/provider zhipu | deepseek | openai',
    '设置代理：/proxy http://127.0.0.1:10793',
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
 * 渲染 /mcp 状态总览。
 * @param mgr MCP 管理器。
 * @returns 状态文本。
 */
function renderMcpStatus(mgr: MCPManager): string {
  const statuses = mgr.getStatus()
  const configPath = getGlobalMcpConfigPath()
  if (statuses.length === 0) {
    return [
      'MCP 配置：' + configPath,
      '（未配置任何 mcpServers，或全部 disabled）',
      '',
      '子命令：list | resources | prompts | reload',
    ].join('\n')
  }
  const lines = statuses.map((s) => {
    const state = s.connected ? `已连接 (${s.transport})` : `失败: ${s.error ?? '未知'}`
    return (
      `  ${s.id}: ${state}\n` +
      `    tools=${s.toolCount} resources=${s.resourceCount} prompts=${s.promptCount}`
    )
  })
  return [
    'MCP Server 状态：',
    ...lines,
    '',
    `动态工具已注册：${globalToolRegistry.mcpCount} 个`,
    `配置文件：${configPath}`,
    '子命令：/mcp list | resources | prompts | reload',
  ].join('\n')
}

/**
 * 渲染 MCP 工具列表。
 * @param mgr MCP 管理器。
 * @returns 工具列表文本。
 */
function renderMcpToolsList(mgr: MCPManager): string {
  const groups = mgr.listToolsSummary()
  if (groups.every((g) => g.tools.length === 0)) {
    return '（无 MCP 工具或未连接 server）'
  }
  const lines: string[] = ['MCP 工具列表：']
  for (const g of groups) {
    lines.push(`\n[${g.serverId}]`)
    for (const t of g.tools) {
      lines.push(`  - ${t.name}${t.description ? ': ' + t.description : ''}`)
    }
  }
  return lines.join('\n')
}

/**
 * 渲染 MCP resources 列表。
 * @param mgr MCP 管理器。
 * @returns resources 文本。
 */
function renderMcpResourcesList(mgr: MCPManager): string {
  const items = mgr.listAllResources()
  if (items.length === 0) return '（无 MCP resources）'
  return [
    'MCP Resources：',
    ...items.map(
      (r) =>
        `  [${r.serverId}] ${r.uri} (${r.name})${r.description ? ' — ' + r.description : ''}`,
    ),
  ].join('\n')
}

/**
 * 渲染 MCP prompts 列表。
 * @param mgr MCP 管理器。
 * @returns prompts 文本。
 */
function renderMcpPromptsList(mgr: MCPManager): string {
  const items = mgr.listAllPrompts()
  if (items.length === 0) return '（无 MCP prompts）'
  return [
    'MCP Prompts：',
    ...items.map((p) => {
      const args = p.arguments?.map((a) => a.name).join(', ') ?? ''
      return `  [${p.serverId}] ${p.name}${args ? ` (${args})` : ''}${p.description ? ' — ' + p.description : ''}`
    }),
  ].join('\n')
}

/**
 * 计算项目技能文件路径（供 /skill create 提示）。
 * @param cwd 工作目录。
 * @param name 技能名。
 * @returns .md 绝对路径。
 */
function joinSkillPath(cwd: string, name: string): string {
  return join(getProjectSkillsDir(cwd), `${name}.md`)
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
