// 斜杠命令系统。
// 解析并执行以 "/" 开头的本地命令（不发送给模型），如 /help、/model、/cost、/init、/clear 等。
// 命令通过 SlashCommandResult 把“要展示的信息 / 要触发的 UI 流程 / 要代为提交的 prompt”
// 返回给上层 UI 处理，从而与 Agent、配置、界面解耦。
// 制作人：Moriarty_Dox

import {
  PRODUCT_NAME,
  AUTHOR,
  VERSION,
  SUPPORTED_MODELS,
  REASONING_EFFORTS,
  MIN_THINKING_BUDGET,
  MAX_THINKING_BUDGET,
  isSupportedModelName,
  isValidReasoningEffort,
  mapEffortToDeepSeek,
  parseThinkingBudget,
} from '../constants.js'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
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
import { renderExtraDirsList } from '../core/workspaceDirs.js'
import {
  buildCommitAgentPrompt,
  buildPrAgentPrompt,
  buildReviewAgentPrompt,
  parseReviewFocuses,
  renderGitStatusReport,
  REVIEW_FOCUS_META,
  type ReviewScope,
} from '../core/gitUtils.js'
import {
  checkForUpdate,
  renderUpdateStatus,
  runUpdate,
} from '../core/updater.js'
import { getMcpManager, type MCPManager } from '../mcp/client.js'
import { getGlobalMcpConfigPath } from '../mcp/config.js'
import { formatCost } from '../deepseek/pricing.js'
import { getModelPricingStatus } from '../providers/pricing.js'
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
import {
  contextOverrideKey,
  formatContextWindowLabel,
  getCompactThreshold,
  getModelContextOptions,
  parseContextWindowInput,
  renderModelSwitchContextHint,
  resolveContextWindow,
} from '../providers/contextWindow.js'

// /model 命令主名：用于命令名阶段判断「是否为 model 前缀」以提前展示 context 子选项。
const MODEL_COMMAND_NAME = 'model'

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
  // 可选：长耗时命令（如 /update 下载安装）的实时进度回调。
  // 上层 UI 据此在实时区展示下载/安装进度，不提供时命令应静默完成。
  onProgress?: (info: { title: string; text: string }) => void
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

/**
 * 处理 /model context 子命令：查看或设置「当前模型的最大上下文长度」。
 * - 无参数：展示当前生效窗口、可选档位（多档模型）与对应的自动压缩阈值（窗口×90%）；
 * - 带参数（如 128k / 200000）：在合法候选内切换档位并持久化；单档模型不可切换会给出提示。
 * 设定会同时影响状态栏进度条上限与自动压缩触发点（随模型切换、随选择变化）。
 * @param ctx 命令上下文。
 * @param arg context 之后的剩余参数（已去空白）。
 * @returns 命令结果（展示信息）。
 */
function handleModelContextCommand(
  ctx: SlashCommandContext,
  arg: string,
): SlashCommandResult {
  const providerId = getActiveProviderId(ctx.config)
  const model = ctx.config.model
  const options = getModelContextOptions(providerId, model)
  const current = resolveContextWindow(
    providerId,
    model,
    ctx.config.modelContextOverrides,
  )

  // 无参数：渲染当前状态 + 可选档位列表。
  if (!arg) {
    return { message: renderModelContextInfo(providerId, model, current, options) }
  }

  // 单档模型：没有可选项，直接说明该模型上下文长度固定。
  if (options.length <= 1) {
    return {
      message:
        `模型 ${model} 的最大上下文长度固定为 ${formatContextWindowLabel(current)}` +
        `（${current.toLocaleString()} tokens），不支持切换。\n` +
        `自动压缩阈值：${getCompactThreshold(current).toLocaleString()} tokens（窗口的 90%）。`,
    }
  }

  // 解析目标档位（支持 128k / 1m / 纯数字）。
  const parsed = parseContextWindowInput(arg)
  if (parsed === undefined) {
    return {
      message:
        `无法识别的上下文长度：「${arg}」。\n` +
        `请使用如 128k、200k、1m 或纯数字（如 128000）。\n\n` +
        renderModelContextInfo(providerId, model, current, options),
    }
  }

  // 校验是否为该模型的合法候选档位。
  if (!options.includes(parsed)) {
    const labels = options.map((o) => formatContextWindowLabel(o)).join(' / ')
    return {
      message:
        `${formatContextWindowLabel(parsed)} 不是模型 ${model} 的可选档位。\n` +
        `可选：${labels}。`,
    }
  }

  // 写入「provider:model → 选定窗口」并热更新；UI 与压缩阈值随之生效。
  const key = contextOverrideKey(providerId, model)
  ctx.applyConfig({ modelContextOverrides: { [key]: parsed } })
  return {
    message:
      `已将模型 ${model} 的最大上下文长度设为 ${formatContextWindowLabel(parsed)}` +
      `（${parsed.toLocaleString()} tokens）。\n` +
      `自动压缩阈值随之变为 ${getCompactThreshold(parsed).toLocaleString()} tokens（窗口的 90%）。`,
  }
}

/**
 * 渲染 /model context 的当前状态信息（当前窗口、压缩阈值、可选档位）。
 * @param providerId Provider 标识。
 * @param model 模型名。
 * @param current 当前生效窗口 token 数。
 * @param options 可选档位列表（升序）。
 * @returns 多行展示文本。
 */
function renderModelContextInfo(
  providerId: ProviderId,
  model: string,
  current: number,
  options: number[],
): string {
  const lines: string[] = []
  lines.push(`模型 ${model}（${providerId}）上下文设置：`)
  lines.push(
    `  当前最大上下文长度：${formatContextWindowLabel(current)}（${current.toLocaleString()} tokens）`,
  )
  lines.push(
    `  自动压缩阈值：${getCompactThreshold(current).toLocaleString()} tokens（窗口的 90%）`,
  )
  if (options.length > 1) {
    const labels = options
      .map((o) => {
        const mark = o === current ? ' ✓当前' : ''
        return `${formatContextWindowLabel(o)}${mark}`
      })
      .join(' / ')
    lines.push(`  可选档位：${labels}`)
    lines.push(`  切换示例：/model context ${formatContextWindowLabel(options[0]).toLowerCase()}`)
  } else {
    lines.push('  该模型上下文长度固定，无可切换档位。')
  }
  return lines.join('\n')
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
    description:
      '查看或切换模型，例如 /model deepseek-v4-pro；/model context 查看或设置最大上下文长度',
    run: (ctx) => {
      const target = ctx.args.trim()
      // 无参数：打开模型选择器。
      if (!target) return { openFlow: 'model' }
      // 子命令：/model context [档位] —— 查看 / 设置当前模型的最大上下文长度（仅多档模型可切换）。
      const ctxMatch = /^(context|ctx)\b(.*)$/i.exec(target)
      if (ctxMatch) {
        return handleModelContextCommand(ctx, ctxMatch[2].trim())
      }
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
      // 若目标模型支持多档上下文长度，追加一行引导，提示可用 /model context 调整窗口与压缩阈值。
      const hint = renderModelSwitchContextHint(
        providerId,
        target,
        ctx.config.modelContextOverrides,
      )
      return { message: hint ? `已切换模型为 ${target}\n${hint}` : `已切换模型为 ${target}` }
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
    name: 'sound',
    description: '开关提示音效（on/off；输入发送、权限请求、中断、结束、通知时发声）',
    run: (ctx) => {
      const cur = ctx.config.soundEnabled !== false
      const target = (ctx.args ?? '').trim().toLowerCase()
      // 支持显式 on/off，无参或其它输入则取反切换。
      let next: boolean
      if (target === 'on' || target === '开' || target === 'true') next = true
      else if (target === 'off' || target === '关' || target === 'false') next = false
      else next = !cur
      ctx.applyConfig({ soundEnabled: next })
      return {
        message: next
          ? '提示音效已开启：输入发送、权限请求、异常中断、输出结束、通知时会发出终端响铃。\n（若听不到声音，请检查终端/系统是否启用了响铃 BEL。）'
          : '提示音效已关闭。',
      }
    },
  },
  {
    name: 'effort',
    description: '查看或切换推理强度：low | medium | high | max（Thinking 模式下生效）',
    aliases: ['reasoning-effort'],
    run: (ctx) => {
      const target = ctx.args.trim().toLowerCase()
      if (!target) {
        const cur = ctx.config.reasoningEffort
        return {
          message:
            `当前推理强度：${cur}\n` +
            `可选：${REASONING_EFFORTS.join('、')}（例如 /effort max）\n` +
            '说明：仅在 Thinking 模式启用时传给 API；/thinking 关闭时不发送 reasoning_effort。\n' +
            `注意：DeepSeek V4 实际仅认 high / max，low / medium 会自动归并为 high（当前将以 ${mapEffortToDeepSeek(cur)} 发送）。`,
        }
      }
      if (!isValidReasoningEffort(target)) {
        return {
          message: `无效的推理强度：${target}\n可用：${REASONING_EFFORTS.join('、')}`,
        }
      }
      ctx.applyConfig({ reasoningEffort: target })
      const note =
        target === 'low' || target === 'medium'
          ? `（DeepSeek 将以 ${mapEffortToDeepSeek(target)} 发送）`
          : ''
      return { message: `已切换推理强度为 ${target}。${note}` }
    },
  },
  {
    name: 'thinking-budget',
    description: '查看或设置思维链 token 预算（仅支持该参数的 Provider 生效；clear 清除）',
    aliases: ['budget'],
    run: (ctx) => {
      const target = ctx.args.trim().toLowerCase()
      // 无参数：展示当前预算与用法。
      if (!target) {
        const cur = ctx.config.thinkingBudget
        return {
          message:
            `当前思维链预算：${cur !== undefined ? `${cur} tokens` : '未设置（由模型自行决定）'}\n` +
            `用法：/thinking-budget <${MIN_THINKING_BUDGET}~${MAX_THINKING_BUDGET}>（如 /thinking-budget 16000）；/thinking-budget clear 清除。\n` +
            '说明：约束思维链长度（thinking.budget_tokens），仅对支持该参数的 Provider 生效；DeepSeek V4 无独立预算上限会忽略此值。',
        }
      }
      // clear：清除预算配置。
      if (target === 'clear') {
        ctx.applyConfig({ thinkingBudget: undefined })
        return { message: '已清除思维链预算配置（恢复为由模型自行决定）。' }
      }
      const budget = parseThinkingBudget(target)
      if (budget === undefined) {
        return {
          message: `无效的思维链预算：${target}\n请输入 ${MIN_THINKING_BUDGET}~${MAX_THINKING_BUDGET} 之间的整数。`,
        }
      }
      ctx.applyConfig({ thinkingBudget: budget })
      return { message: `已设置思维链预算为 ${budget} tokens。` }
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
    name: 'review',
    description: '代码审查：审查工作区/已暂存/分支差异或指定文件（按严重度分级）',
    aliases: ['cr'],
    run: (ctx) => {
      const raw = ctx.args.trim()

      // /review status：直接展示 git 状态。
      if (raw.toLowerCase() === 'status') {
        return { message: renderGitStatusReport(ctx.agent.cwd) }
      }

      // /review help：用法说明。
      if (raw.toLowerCase() === 'help' || raw === '?') {
        return { message: renderReviewHelp() }
      }

      const parsed = parseReviewArgs(raw, ctx.agent.cwd)
      const built = buildReviewAgentPrompt(ctx.agent.cwd, parsed.scope, parsed.focuses)
      if (!built.ok) {
        return { message: built.error + '\n\n' + renderReviewHelp() }
      }
      return {
        message: `开始代码审查…\n\n${built.summary}`,
        submitPrompt: built.prompt,
      }
    },
  },
  {
    name: 'add-dir',
    description: '将额外目录加入工作上下文（项目级持久化，文件工具可访问）',
    aliases: ['adddir'],
    run: (ctx) => {
      const raw = ctx.args.trim()

      // 无参数或 list：展示当前额外目录。
      if (!raw || raw.toLowerCase() === 'list' || raw.toLowerCase() === 'ls') {
        return { message: renderExtraDirsList(ctx.agent.cwd, ctx.agent.getExtraDirs()) }
      }

      // 解析子命令：remove / rm / clear。
      const spaceIdx = raw.indexOf(' ')
      const sub = (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).toLowerCase()
      const rest = spaceIdx === -1 ? '' : raw.slice(spaceIdx + 1).trim()

      if (sub === 'clear') {
        const n = ctx.agent.clearExtraDirs()
        return {
          message: n > 0 ? `已清空 ${n} 个额外工作目录。` : '当前没有额外工作目录。',
        }
      }

      if (sub === 'remove' || sub === 'rm' || sub === 'del') {
        if (!rest) {
          return { message: '用法：/add-dir remove <目录路径>' }
        }
        const result = ctx.agent.removeExtraDir(rest)
        return {
          message: result.removed
            ? `已移除额外工作目录：${result.resolved}`
            : `未找到该额外工作目录：${rest}（用 /add-dir list 查看）`,
        }
      }

      // 默认：把 raw 整体当作要添加的目录路径（支持含空格的路径）。
      const result = ctx.agent.addExtraDir(raw)
      if (!result.ok) {
        return { message: `添加失败：${result.error}` }
      }
      if (result.alreadyPresent) {
        return { message: `该目录已在工作上下文中：${result.resolved}` }
      }
      return {
        message:
          `已将目录加入工作上下文：${result.resolved}\n` +
          '该目录已项目级持久化，下次在本项目启动时自动恢复。\n' +
          '现在 read_file / write_file / edit_file / glob / grep / list_dir 可访问其中文件。',
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
        // 检测阶段也上报进度（“正在从 GitHub 检测最新版本…”）。
        const check = await checkForUpdate({
          forceRefresh: force,
          onProgress: (text) => ctx.onProgress?.({ title: '检测更新', text }),
        })
        return { message: renderUpdateStatus(check) }
      }
      if (sub === 'run' || sub === 'install' || sub === 'force') {
        // 更新阶段把 git pull / npm install 的实时输出推送到 UI 实时区。
        const result = await runUpdate({
          force: sub === 'force',
          onProgress: (text) => ctx.onProgress?.({ title: '更新 DCODE', text }),
        })
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
 * 生成 /model context 相关的补全候选（context 子命令 + 多档模型的各档位快捷项）。
 * 抽取为独立函数，便于「输入命令名阶段（如 /m、/model）」与「参数阶段（/model <ctx>）」复用，
 * 保证用户从 / 一路输入到 /model 的全过程都能看到 context 选项（与 /provider 子选项体验一致）。
 * @param q 当前查询前缀（小写）：用于过滤 context 与档位标签；为空则全部返回。
 * @param config 当前配置（用于解析当前模型的多档候选）。
 * @returns context 子命令及档位补全列表（可能为空）。
 */
function getModelContextArgSuggestions(
  q: string,
  config?: DCodeConfig,
): CommandSuggestion[] {
  const suggestions: CommandSuggestion[] = []
  // context 子命令本身：当查询是 'context' 的前缀（或为空）时给出。
  if ('context'.startsWith(q) || q === '') {
    suggestions.push({
      name: 'context',
      description: '查看/设置最大上下文长度（影响压缩阈值）',
      completion: '/model context',
    })
  }
  // 多档模型再补出各档位的快捷补全（如 /model context 200k）。
  if (config) {
    const providerId = getActiveProviderId(config)
    const options = getModelContextOptions(providerId, config.model)
    if (options.length > 1) {
      for (const o of options) {
        const label = formatContextWindowLabel(o)
        const name = `context ${label}`
        // 允许用 'context'、'context 2'、'200k' 等多种前缀命中该档位。
        const lowerLabel = label.toLowerCase()
        if (
          q === '' ||
          name.toLowerCase().startsWith(q) ||
          lowerLabel.startsWith(q) ||
          'context'.startsWith(q)
        ) {
          suggestions.push({
            name,
            description: `将最大上下文长度设为 ${label}`,
            completion: `/model context ${lowerLabel}`,
          })
        }
      }
    }
  }
  return suggestions
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
    const suggestions: CommandSuggestion[] = models
      .filter((m) => q === '' || m.toLowerCase().startsWith(q))
      .map((m) => {
        const isFree = providerId === 'zhipu' && isZhipuFreeModel(m)
        return {
          name: isFree ? `★ ${m}` : m,
          description: isFree ? ZHIPU_FREE_MODEL_BADGE : '切换模型',
          completion: `/model ${m}`,
        }
      })
    // 追加 context 子命令提示；多档模型再补出各档位的快捷补全（复用统一生成器）。
    suggestions.push(...getModelContextArgSuggestions(q, config))
    return suggestions
  }

  if (cmdName === 'review') {
    const options = [
      { name: 'staged', description: '仅审查已暂存变更' },
      { name: 'status', description: '查看 Git 状态' },
      ...REVIEW_FOCUS_META.map((m) => ({
        name: m.id,
        description: `聚焦：${m.label}`,
      })),
    ]
    return options
      .filter((o) => q === '' || o.name.startsWith(q))
      .map((o) => ({
        name: o.name,
        description: o.description,
        completion: `/review ${o.name}`,
      }))
  }

  if (cmdName === 'add-dir') {
    const options = [
      { name: 'list', description: '查看已添加的额外目录' },
      { name: 'remove', description: '移除某个额外目录' },
      { name: 'clear', description: '清空全部额外目录' },
    ]
    return options
      .filter((o) => q === '' || o.name.startsWith(q))
      .map((o) => ({
        name: o.name,
        description: o.description,
        completion: `/add-dir ${o.name}`,
      }))
  }

  // /effort：四级推理强度子选项（low / medium / high / max）。
  if (cmdName === 'effort') {
    return REASONING_EFFORTS.filter((e) => q === '' || e.startsWith(q)).map((e) => ({
      name: e,
      description:
        e === 'max'
          ? '最高强度（复杂 agentic 任务）'
          : e === 'high'
            ? '高强度（默认，多数推理任务）'
            : `${e}（DeepSeek 归并为 ${mapEffortToDeepSeek(e)}）`,
      completion: `/effort ${e}`,
    }))
  }

  // /thinking-budget：clear 子选项（具体数值无法穷举，仅提示清除）。
  if (cmdName === 'thinking-budget') {
    const options = [
      { name: 'clear', description: '清除思维链预算（由模型自行决定）' },
    ]
    return options
      .filter((o) => q === '' || o.name.startsWith(q))
      .map((o) => ({
        name: o.name,
        description: o.description,
        completion: `/thinking-budget ${o.name}`,
      }))
  }

  return []
}

/**
 * 将某命令的参数子选项插入到该命令项之后（顶层命令列表中）。
 * 用于在「输入命令名阶段」让 /provider、/model 等命令的子选项随命令一同出现，
 * 实现「从 / 一路输入到完整命令名，子选项全程可见」的补全体验。
 * @param commandItems 已匹配的顶层命令建议。
 * @param args 该命令的参数级建议。
 * @param commandCompletion 目标命令的 completion（如 '/provider'、'/model'）。
 * @returns 合并后的建议列表；目标命令不在列表中时把子选项追加到末尾。
 */
function appendArgSuggestionsAfterCommand(
  commandItems: CommandSuggestion[],
  args: CommandSuggestion[],
  commandCompletion: string,
): CommandSuggestion[] {
  if (args.length === 0) return commandItems
  const idx = commandItems.findIndex((c) => c.completion === commandCompletion)
  if (idx >= 0) {
    return [...commandItems.slice(0, idx + 1), ...args, ...commandItems.slice(idx + 1)]
  }
  return [...commandItems, ...args]
}

/**
 * 将 Provider 子选项插入到 /provider 命令项之后（保留向后兼容的薄封装）。
 * @param commandItems 已匹配的顶层命令建议。
 * @param args Provider 参数级建议。
 * @returns 合并后的建议列表。
 */
function appendProviderArgSuggestions(
  commandItems: CommandSuggestion[],
  args: CommandSuggestion[],
): CommandSuggestion[] {
  return appendArgSuggestionsAfterCommand(commandItems, args, '/provider')
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
    // /model 的 context 子选项：在「命令名阶段」也一并给出，使从 / 一路输入到 /model 全程可见
    // （与 /provider 子选项的体验一致，不必等到完整输入 /model 才出现）。
    const modelContextArgs = getModelContextArgSuggestions('', config)

    // 仅输入 /：全部命令 + Provider 子选项 + /model context 子选项（分别插入到各自命令项之后）。
    if (q === '') {
      let items = commandItems
      if (providerArgs.length > 0) items = [...items, ...providerArgs]
      items = appendArgSuggestionsAfterCommand(items, modelContextArgs, '/model')
      return items
    }

    // 输入 /p … /provider 前缀：保留 plan/proxy/provider 等命令，并在 /provider 后追加子选项。
    if (PROVIDER_COMMAND_NAME.startsWith(q)) {
      return appendProviderArgSuggestions(commandItems, providerArgs)
    }

    // 其它命令完整匹配：展示参数子选项（如 /model 的模型列表 + context、/review、/add-dir）。
    const exact = COMMANDS.find(
      (cmd) =>
        cmd.name.toLowerCase() === q ||
        (cmd.aliases ?? []).some((a) => a.toLowerCase() === q),
    )
    if (exact && exact.name !== 'provider') {
      const args = getCommandArgSuggestions(exact.name, '', config)
      if (args.length > 0) return args
    }

    // 输入 /m … /model 的「部分前缀」（尚未完整输入 /model）：在 /model 命令项后追加 context 子选项，
    // 使从 / 一路输入到 /model 全程都能看到 context（完整匹配走上面的 exact 分支，含模型列表）。
    if (MODEL_COMMAND_NAME.startsWith(q)) {
      return appendArgSuggestionsAfterCommand(commandItems, modelContextArgs, '/model')
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
    `适配多供应商DCode AI 助手`,
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
  const status = getModelPricingStatus(agent.getProviderId(), agent.getModel())
  // 区分三态：免费模型显示「免费」；未配置价目的收费模型显示「未知」而非误报免费；其余按金额。
  let costLine: string
  if (status === 'free') {
    costLine = '免费（该模型不计费）'
  } else if (status === 'unknown') {
    costLine =
      `未知（该模型未配置定价，无法估算）` +
      `${u.inputTokens + u.outputTokens > 0 ? `；累计用量 输入 ${u.inputTokens} / 输出 ${u.outputTokens} token` : ''}`
  } else {
    costLine = formatCost(u.costUsd)
  }
  return [
    '本次会话用量统计：',
    `  Provider / 模型：${agent.getProviderId()} / ${agent.getModel()}`,
    `  输入 token：${u.inputTokens}（其中缓存命中 ${u.cacheHitTokens}）`,
    `  输出 token：${u.outputTokens}`,
    `  预估成本：${costLine}`,
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
    `  思维链预算：${config.thinkingBudget !== undefined ? `${config.thinkingBudget} tokens` : '未设置'}`,
    `  Hooks：${config.hooksEnabled !== false ? '启用' : '禁用'}`,
    `  提示音效：${config.soundEnabled !== false ? '开' : '关'}`,
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
 * 解析 /review 命令参数：拆分审查范围与聚焦维度。
 *
 * 支持形式：
 *   /review                       → 工作区全部改动（默认）
 *   /review staged                → 仅已暂存
 *   /review main                  → 相对基线分支 main
 *   /review src/foo.ts            → 指定文件
 *   /review staged security perf  → 范围 + 聚焦维度
 *   /review --focus security,perf → 显式聚焦（范围仍为默认/已识别）
 *
 * @param raw /review 之后的原始参数串（已 trim）。
 * @param cwd 工作目录（用于判定 token 是文件还是分支）。
 * @returns 解析出的审查范围与聚焦维度数组。
 */
function parseReviewArgs(
  raw: string,
  cwd: string,
): { scope: ReviewScope; focuses: ReturnType<typeof parseReviewFocuses> } {
  const focusTokens: string[] = []
  const restTokens: string[] = []

  const tokens = raw.split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    const lower = tok.toLowerCase()

    // 显式聚焦参数：--focus a,b / --focus=a,b / -f a,b。
    if (lower === '--focus' || lower === '-f' || lower === '--focus=') {
      const next = tokens[i + 1]
      if (next) {
        focusTokens.push(...next.split(','))
        i++ // 跳过已消费的值。
      }
      continue
    }
    if (lower.startsWith('--focus=')) {
      focusTokens.push(...tok.slice('--focus='.length).split(','))
      continue
    }

    // 直接作为维度别名的裸 token（如 security、perf）。
    if (parseReviewFocuses([lower]).length > 0) {
      focusTokens.push(lower)
      continue
    }

    restTokens.push(tok)
  }

  const focuses = parseReviewFocuses(focusTokens)

  // 解析范围：取第一个非维度 token 作为范围目标。
  const target = restTokens[0]
  if (!target) {
    return { scope: { kind: 'working' }, focuses }
  }
  if (target.toLowerCase() === 'staged' || target.toLowerCase() === 'cached') {
    return { scope: { kind: 'staged' }, focuses }
  }
  if (target.toLowerCase() === 'working' || target.toLowerCase() === 'workdir') {
    return { scope: { kind: 'working' }, focuses }
  }
  // 看起来像文件路径（存在于磁盘，或含路径分隔符 / 扩展名）→ 文件审查。
  if (looksLikeFilePath(target, cwd)) {
    return { scope: { kind: 'file', path: target }, focuses }
  }
  // 否则视为基线分支名。
  return { scope: { kind: 'base', base: target }, focuses }
}

/**
 * 判断一个 token 是否更像文件路径（而非 git 分支名）。
 * 规则：磁盘上存在该路径，或包含路径分隔符 / 常见文件扩展名。
 * @param token 待判定 token。
 * @param cwd 工作目录。
 * @returns 像文件返回 true。
 */
function looksLikeFilePath(token: string, cwd: string): boolean {
  const abs = isAbsolute(token) ? token : resolve(cwd, token)
  if (existsSync(abs)) return true
  // 含路径分隔符通常是文件/目录引用。
  if (token.includes('/') || token.includes('\\')) return true
  // 含扩展名（点号后跟若干字母）也偏向文件。
  if (/\.[a-z0-9]{1,8}$/i.test(token)) return true
  return false
}

/**
 * 渲染 /review 用法说明。
 * @returns 多行帮助文本。
 */
function renderReviewHelp(): string {
  const focusList = REVIEW_FOCUS_META.map((m) => `${m.id}（${m.label}）`).join('、')
  return [
    '/review 代码审查用法：',
    '  /review                 审查工作区全部改动（已暂存 + 未暂存，默认）',
    '  /review staged          仅审查已暂存（git add 后）的变更',
    '  /review <基线分支>       审查当前分支相对基线的差异，如 /review main',
    '  /review <文件路径>       审查指定文件，如 /review src/foo.ts',
    '  /review status          查看 Git 状态',
    '',
    '聚焦维度（可叠加，附加在任意范围后，或用 --focus a,b）：',
    `  ${focusList}`,
    '  示例：/review staged security perf   或   /review main --focus readability',
    '',
    '说明：审查结果按 Critical / Warning / Suggestion 分级，仅分析不改动文件。',
  ].join('\n')
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
