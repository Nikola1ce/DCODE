// 连接私有的宿主工具注册表与调用代理。
// 注册快照不写入全局工具表；调用结果、超时与取消均在所属连接内关联和结算。
// 制作人：Moriarty_Dox

import { randomUUID } from 'node:crypto'
import type { ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

/** 宿主必须完整声明权限属性；推荐使用 host__ 前缀，mcp__ 为保留前缀。 */
export interface HostToolDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
  readOnly: boolean
  requiresPermission: boolean
  /** 0 表示等待至结果、取消或断线；普通工具默认 5 分钟，ask_user 默认不限时。 */
  timeoutMs?: number
}

export type HostToolMessage =
  | {
    type: 'host_tool_call'
    hostCallId: string
    requestId: string
    toolCallId: string
    name: string
    input: unknown
  }
  | { type: 'host_tool_cancel'; hostCallId: string }

export interface HostToolRegistryOptions {
  send: (message: HostToolMessage) => void | Promise<void>
  /** 注入内置/MCP 工具查询以检查保留名；不向其注册宿主工具。 */
  getTool: (name: string) => ToolDefinition | undefined
}

export const HOST_TOOL_LIMITS = Object.freeze({
  maxTools: 64,
  maxDescriptionBytes: 8 * 1024,
  maxSchemaBytes: 64 * 1024,
  maxSnapshotBytes: 512 * 1024,
  maxResultBytes: 1024 * 1024,
  maxPendingCalls: 128,
  defaultTimeoutMs: 5 * 60 * 1000,
  maxTimeoutMs: 24 * 60 * 60 * 1000,
})

interface PendingHostCall {
  resolve: (result: ToolResult) => void
  cleanup: () => void
  sent: boolean
}

/** 每个 IDE 连接各创建一个实例；disconnect 后不可复用。 */
export class HostToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private pending = new Map<string, PendingHostCall>()
  private connected = true

  constructor(private readonly options: HostToolRegistryOptions) {}

  /** 原子替换整个注册快照；校验失败时保留旧快照。空数组表示移除全部工具。 */
  register(declarations: unknown): void {
    if (!this.connected) throw new Error('宿主连接已断开，不能注册工具。')
    if (!Array.isArray(declarations) || declarations.length > HOST_TOOL_LIMITS.maxTools) {
      throw new Error(`宿主工具快照必须是数组，且不得超过 ${HOST_TOOL_LIMITS.maxTools} 个工具。`)
    }
    const snapshot = copyJson(declarations, HOST_TOOL_LIMITS.maxSnapshotBytes, '宿主工具快照') as unknown[]
    const next = new Map<string, ToolDefinition>()
    for (const value of snapshot) {
      const declaration = validateDeclaration(value)
      if (/^mcp__/i.test(declaration.name) || this.options.getTool(declaration.name)) {
        throw new Error(`宿主工具名称与内置/MCP 工具冲突：${declaration.name}`)
      }
      if (next.has(declaration.name)) throw new Error(`宿主工具名称重复：${declaration.name}`)
      next.set(declaration.name, this.createTool(declaration))
    }
    this.tools = next
  }

  /** 仅由所属 Agent 合并进可用工具列表，不修改全局注册表。 */
  getTools(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** 返回是否消费了在途 ID；无效结果转成工具错误，重复、迟到和其他连接的 ID 均忽略。 */
  acceptResult(hostCallId: string, result: unknown): boolean {
    if (!this.pending.has(hostCallId)) return false
    let validated: ToolResult
    try {
      validated = validateResult(result)
    } catch (error) {
      validated = failure(`宿主工具返回结果无效：${errorMessage(error)}`)
    }
    return this.settle(hostCallId, validated)
  }

  /** 结算所有在途调用并清理计时器/监听器；发送取消消息是尽力而为。 */
  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    this.tools.clear()
    for (const id of this.pending.keys()) {
      this.settle(id, failure('宿主连接已断开，工具调用已终止。'), true)
    }
  }

  private createTool(declaration: HostToolDeclaration): ToolDefinition {
    const tool: ToolDefinition = {
      name: declaration.name,
      description: declaration.description,
      parameters: freezeJson(declaration.parameters),
      readOnly: declaration.readOnly,
      // 宿主自报只读只影响 plan 可用性，不能据此推断并行安全或跳过授权。
      safety: { sideEffect: 'state', parallelSafe: false },
      checkPermission: (input, ctx) => declaration.requiresPermission ? {
        toolName: declaration.name,
        title: `执行宿主工具 ${declaration.name}`,
        ruleKey: `HostTool(${declaration.name})`,
        toolCallId: ctx.toolCallId,
        input,
        details: { kind: 'host', toolName: declaration.name, input },
      } : null,
      run: (input, ctx) => this.invoke(tool, declaration, input, ctx),
    }
    return Object.freeze(tool)
  }

  private async invoke(
    tool: ToolDefinition,
    declaration: HostToolDeclaration,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!this.connected) return failure('宿主连接已断开，无法调用工具。')
    if (ctx.abortSignal.aborted) return failure('宿主工具调用已取消。')
    if (this.tools.get(tool.name) !== tool) return failure(`宿主工具已移除或重新注册：${tool.name}`)
    if (!ctx.runId || !ctx.toolCallId) return failure('宿主工具调用缺少 runId 或 toolCallId。')
    if (this.pending.size >= HOST_TOOL_LIMITS.maxPendingCalls) return failure('等待中的宿主工具调用过多。')
    try {
      if (this.options.getTool(tool.name)) return failure(`宿主工具名称与内置/MCP 工具冲突：${tool.name}`)
    } catch (error) {
      return failure(`宿主工具名称检查失败：${errorMessage(error)}`)
    }

    const hostCallId = randomUUID()
    const timeoutMs = declaration.timeoutMs
      ?? (['ask_user', 'host__ask_user'].includes(tool.name) ? 0 : HOST_TOOL_LIMITS.defaultTimeoutMs)
    const message: HostToolMessage = {
      type: 'host_tool_call', hostCallId, requestId: ctx.runId,
      toolCallId: ctx.toolCallId, name: tool.name, input,
    }
    return new Promise<ToolResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => this.settle(hostCallId, failure('宿主工具调用已取消。'), true)
      const pending: PendingHostCall = {
        resolve,
        sent: false,
        cleanup: () => {
          if (timer !== undefined) clearTimeout(timer)
          ctx.abortSignal.removeEventListener('abort', onAbort)
        },
      }
      this.pending.set(hostCallId, pending)
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.settle(hostCallId, failure(`宿主工具调用超时（${timeoutMs}ms）：${tool.name}`), true)
        }, timeoutMs)
      }
      if (ctx.abortSignal.aborted) {
        onAbort()
        return
      }
      // 先建立等待项，send 可以同步回传结果、触发取消或断线。
      pending.sent = true
      try {
        Promise.resolve(this.options.send(message)).catch((error) => {
          this.settle(hostCallId, failure(`宿主工具请求发送失败：${errorMessage(error)}`), true)
        })
      } catch (error) {
        this.settle(hostCallId, failure(`宿主工具请求发送失败：${errorMessage(error)}`), true)
      }
    })
  }

  private settle(hostCallId: string, result: ToolResult, cancel = false): boolean {
    const pending = this.pending.get(hostCallId)
    if (!pending) return false
    this.pending.delete(hostCallId)
    pending.cleanup()
    pending.resolve(result)
    if (cancel && pending.sent) {
      try {
        Promise.resolve(this.options.send({ type: 'host_tool_cancel', hostCallId })).catch(() => {})
      } catch {
        // 连接可能已经关闭；取消发送失败不能阻止本地结算。
      }
    }
    return true
  }
}

function validateDeclaration(value: unknown): HostToolDeclaration {
  if (!isRecord(value)) throw new Error('宿主工具声明必须是对象。')
  assertKeys(value, ['name', 'description', 'parameters', 'readOnly', 'requiresPermission', 'timeoutMs'], '宿主工具声明')
  if (typeof value.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.name)) {
    throw new Error('宿主工具名称必须是 1–64 个字母、数字、下划线或连字符。')
  }
  if (typeof value.description !== 'string' || !value.description.trim()
    || Buffer.byteLength(value.description) > HOST_TOOL_LIMITS.maxDescriptionBytes) {
    throw new Error('宿主工具 description 必须为非空字符串且不能过大。')
  }
  if (typeof value.readOnly !== 'boolean' || typeof value.requiresPermission !== 'boolean') {
    throw new Error('宿主工具必须显式声明布尔值 readOnly 和 requiresPermission。')
  }
  if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== 'number'
    || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 0 || value.timeoutMs > HOST_TOOL_LIMITS.maxTimeoutMs)) {
    throw new Error(`宿主工具 timeoutMs 必须为 0–${HOST_TOOL_LIMITS.maxTimeoutMs} 的整数。`)
  }
  if (!isRecord(value.parameters) || value.parameters.type !== 'object') {
    throw new Error('宿主工具 parameters 必须是 type=object 的 JSON Schema。')
  }
  if (Buffer.byteLength(JSON.stringify(value.parameters)) > HOST_TOOL_LIMITS.maxSchemaBytes) {
    throw new Error(`宿主工具 schema 不能超过 ${HOST_TOOL_LIMITS.maxSchemaBytes} 字节。`)
  }
  validateSchema(value.parameters)
  return value as unknown as HostToolDeclaration
}

/** 检查标准结构关键字；保留 JSON Schema 扩展关键字，不尝试执行 schema 或解析远程引用。 */
function validateSchema(value: unknown): void {
  if (typeof value === 'boolean') return
  if (!isRecord(value)) throw new Error('JSON Schema 子节点必须是对象或布尔值。')
  const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
  for (const [key, item] of Object.entries(value)) {
    if (key === 'type') {
      const entries = Array.isArray(item) ? item : [item]
      if (!entries.length || entries.some((entry) => typeof entry !== 'string' || !types.has(entry))
        || new Set(entries).size !== entries.length) throw new Error('JSON Schema type 无效。')
    } else if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key)) {
      if (!isRecord(item)) throw new Error(`JSON Schema ${key} 必须是对象。`)
      Object.values(item).forEach(validateSchema)
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
      if (!Array.isArray(item) || !item.length) throw new Error(`JSON Schema ${key} 必须是非空数组。`)
      item.forEach(validateSchema)
    } else if (key === 'items' && Array.isArray(item)) {
      item.forEach(validateSchema)
    } else if (['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties',
      'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'].includes(key)) {
      validateSchema(item)
    } else if (key === 'required') {
      if (!isStringArray(item)) throw new Error('JSON Schema required 必须是不重复的字符串数组。')
    } else if (key === 'dependentRequired' || key === 'dependencies') {
      if (!isRecord(item)) throw new Error(`JSON Schema ${key} 必须是对象。`)
      for (const entry of Object.values(item)) {
        if (key === 'dependentRequired' || Array.isArray(entry)) {
          if (!isStringArray(entry)) throw new Error(`JSON Schema ${key} 的依赖项必须是不重复的字符串数组。`)
        } else validateSchema(entry)
      }
    } else if (key === 'enum') {
      if (!Array.isArray(item) || !item.length) throw new Error('JSON Schema enum 必须是非空数组。')
    } else if (['$ref', '$schema', '$id', '$anchor', '$dynamicRef', '$dynamicAnchor', 'title', 'description',
      'format', 'pattern', 'contentEncoding', 'contentMediaType'].includes(key)) {
      if (typeof item !== 'string') throw new Error(`JSON Schema ${key} 必须是字符串。`)
    } else if (['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
      'minContains', 'maxContains'].includes(key)) {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) {
        throw new Error(`JSON Schema ${key} 必须是非负整数。`)
      }
    } else if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].includes(key)) {
      if (typeof item !== 'number' || (key === 'multipleOf' && item <= 0)) {
        throw new Error(`JSON Schema ${key} 必须是有效数值。`)
      }
    } else if (['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'].includes(key)) {
      if (typeof item !== 'boolean') throw new Error(`JSON Schema ${key} 必须是布尔值。`)
    }
  }
}

function validateResult(value: unknown): ToolResult {
  const result = copyJson(value, HOST_TOOL_LIMITS.maxResultBytes, '宿主工具结果')
  if (!isRecord(result)) throw new Error('result 必须是对象。')
  assertKeys(result, ['llmContent', 'uiSummary', 'isError', 'changedFiles'], '宿主工具结果')
  if (typeof result.llmContent !== 'string') throw new Error('llmContent 必须是字符串。')
  if (result.uiSummary !== undefined && typeof result.uiSummary !== 'string') throw new Error('uiSummary 必须是字符串。')
  if (result.isError !== undefined && typeof result.isError !== 'boolean') throw new Error('isError 必须是布尔值。')
  if (result.changedFiles !== undefined) {
    if (!Array.isArray(result.changedFiles)) throw new Error('changedFiles 必须是数组。')
    for (const change of result.changedFiles) {
      if (!isRecord(change)) throw new Error('changedFiles 条目必须是对象。')
      assertKeys(change, ['path', 'operation', 'checkpointId', 'added', 'removed'], 'changedFiles 条目')
      if (typeof change.path !== 'string' || !change.path.trim()
        || !['create', 'edit', 'delete'].includes(change.operation as string)) throw new Error('changedFiles 路径或操作无效。')
      if (change.checkpointId !== undefined && typeof change.checkpointId !== 'string') throw new Error('checkpointId 必须是字符串。')
      for (const count of [change.added, change.removed]) {
        if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) {
          throw new Error('changedFiles 行数必须是非负整数。')
        }
      }
    }
  }
  return result as unknown as ToolResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') && new Set(value).size === value.length
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} 包含未知字段。`)
}

/** 限制大小、深度和节点数，并拒绝 JSON 会静默转换/丢弃的值。 */
function copyJson(value: unknown, maxBytes: number, label: string): unknown {
  const ancestors = new Set<object>()
  let nodes = 0
  let stringBytes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 48) throw new Error(`${label} 结构过大或嵌套过深。`)
    if (typeof item === 'string') {
      stringBytes += Buffer.byteLength(item)
      if (stringBytes > maxBytes) throw new Error(`${label} 超过 ${maxBytes} 字节限制。`)
      return
    }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return
    if (!Array.isArray(item) && !isRecord(item)) throw new Error(`${label} 必须是有效 JSON 数据。`)
    if (ancestors.has(item)) throw new Error(`${label} 不能包含循环引用。`)
    if (Object.getOwnPropertySymbols(item).length) throw new Error(`${label} 不能包含 Symbol 字段。`)
    ancestors.add(item)
    for (const [key, entry] of Object.entries(item)) {
      stringBytes += Buffer.byteLength(key)
      if (stringBytes > maxBytes) throw new Error(`${label} 超过 ${maxBytes} 字节限制。`)
      visit(entry, depth + 1)
    }
    ancestors.delete(item)
  }
  visit(value, 0)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > maxBytes) throw new Error(`${label} 超过 ${maxBytes} 字节限制。`)
  return JSON.parse(serialized)
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeJson)
    Object.freeze(value)
  }
  return value
}

function failure(llmContent: string): ToolResult {
  return { llmContent, isError: true }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}
