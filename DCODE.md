# DCODE 项目记忆

## 项目简介

DCODE 是一个运行在终端中的 AI 编程助手，由 **Moriarty_Dox** 打造。借鉴 Claude Code 整体架构（Agent 主循环 + 工具系统 + 全屏 TUI + 斜杠命令 + 会话/记忆/上下文压缩），支持多供应商 OpenAI 兼容 API。

**默认使用智谱 AI 免费模型**（`glm-4-flash`），只需获取智谱 API Key 即可零成本使用；也可随时切换 DeepSeek / OpenAI / Ollama / Custom Provider。

GitHub：https://github.com/Nikola1ce/DCODE

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript（ES2022） |
| 模块格式 | ESM（`"type": "module"`） |
| 运行时 | Node.js >= 18 |
| UI 框架 | React 18 + Ink 5（全屏 TUI） |
| 构建工具 | esbuild（单文件打包） |
| 测试框架 | Vitest |
| LLM SDK | OpenAI SDK（兼容多供应商） |
| MCP | @modelcontextprotocol/sdk |
| 其他 | fast-glob, https-proxy-agent, ignore |

## 目录结构要点

```
DCODE/
├── src/
│   ├── cli.tsx                 # CLI 入口：参数解析、初始化、分流（TUI/无头）
│   ├── config.ts               # 全局配置（~/.dcode/config.json）
│   ├── constants.ts            # 品牌/版本/模型/常量定义
│   ├── memory.ts               # DCODE.md 记忆加载
│   ├── headless.ts             # 无头模式执行器（-p）
│   ├── trace.ts                # 调试追踪系统
│   ├── core/                   # Agent 核心
│   │   ├── agent.ts            # Agent 主循环（兼容旧接口）
│   │   ├── agentRunner.ts      # 新版事件驱动 Agent 内核
│   │   ├── types.ts            # 核心类型（DeepMessage, ToolCall, ToolResult 等）
│   │   ├── systemPrompt.ts     # 系统提示构建
│   │   ├── toolScheduler.ts    # 工具批调度（安全分组执行）
│   │   ├── subAgent.ts         # 子代理并发调度
│   │   ├── compact.ts          # 上下文压缩
│   │   ├── session.ts          # 会话持久化（JSONL）
│   │   ├── checkpoint.ts       # 文件检查点/回滚
│   │   ├── hooks.ts            # 钩子系统
│   │   ├── skills.ts           # 技能包管理
│   │   ├── gitUtils.ts         # Git 集成
│   │   ├── shellManager.ts     # Shell 管理器
│   │   ├── historyTrim.ts      # 发送前历史瘦身
│   │   ├── fileToolLock.ts     # 文件路径锁（防并发冲突）
│   │   ├── projectTrust.ts     # 项目信任机制
│   │   └── updater.ts          # 自动更新
│   ├── tools/                  # 工具系统（每个工具一个模块）
│   │   ├── index.ts            # 工具注册表/总入口
│   │   ├── registry.ts         # 工具权限注册
│   │   ├── readFile.ts, writeFile.ts, editFile.ts, diff.ts
│   │   ├── listDir.ts, glob.ts, grep.ts
│   │   ├── runCommand.ts, bashOutput.ts, killShell.ts
│   │   ├── task.ts, todo.ts
│   │   ├── webSearch.ts, webFetch.ts, webUtils.ts
│   │   ├── notebook.ts, notebookRead.ts, notebookEdit.ts
│   │   └── mcpProxy.ts
│   ├── providers/              # LLM Provider 层
│   │   ├── types.ts            # Provider 抽象接口
│   │   ├── factory.ts          # 客户端工厂
│   │   ├── registry.ts         # Provider 注册（deepseek/openai/zhipu/ollama/custom）
│   │   ├── contextWindow.ts    # 上下文窗口解析
│   │   ├── pricing.ts          # 计价
│   │   ├── proxy.ts            # 代理配置
│   │   ├── openaiModels.ts     # OpenAI 模型列表
│   │   └── zhipuModels.ts      # 智谱模型列表
│   ├── deepseek/               # LLM 客户端实现
│   │   ├── client.ts           # OpenAI 兼容流式客户端
│   │   ├── clientRetry.ts      # 重试逻辑测试
│   │   └── pricing.ts          # DeepSeek 计价
│   ├── ui/                     # Ink TUI 组件
│   │   ├── App.tsx             # 主应用组件
│   │   ├── MessageView.tsx     # 消息展示
│   │   ├── InputPrompt.tsx     # 输入提示
│   │   ├── Banner.tsx          # 欢迎横幅
│   │   ├── CommandMenu.tsx     # 命令菜单
│   │   ├── StatusLine.tsx      # 状态栏
│   │   ├── TodoPanel.tsx       # 任务面板
│   │   ├── theme.ts            # 主题定义
│   │   └── ...                 # 其他 UI 组件
│   ├── mcp/                    # MCP（Model Context Protocol）
│   │   ├── client.ts, config.ts, transport.ts, toolAdapter.ts
│   │   └── types.ts
│   ├── commands/               # 斜杠命令
│   │   ├── index.ts
│   │   └── suggestions.test.ts
│   └── ide/                    # IDE 协议（LSP-like）
│       ├── protocol.ts
│       └── server.ts
├── scripts/                    # 辅助脚本
│   ├── package-release.mjs     # Release 打包脚本
│   ├── trace-analyze.mjs       # 追踪分析
│   └── mcp-test-server.mjs     # MCP 测试服务端
├── assets/                     # 静态资源（提示音等）
├── build-stubs/                # 构建占位模块
├── .github/workflows/release.yml  # CI Release 流程
├── build.mjs                   # esbuild 构建脚本
├── tsconfig.json               # TypeScript 配置
├── vitest.config.ts            # Vitest 配置
└── package.json
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run build` | 构建：esbuild 打包 src/cli.tsx → dist/cli.js |
| `npm run dev` | 开发：监听模式自动重建 |
| `npm run typecheck` | 类型检查：tsc --noEmit |
| `npm test` | 运行全部单元测试（Vitest） |
| `npm run test:watch` | 监听模式运行测试 |
| `npm run start` | 启动已构建的 CLI（node dist/cli.js） |
| `npm run package` | 打包为免安装 ZIP 发布包 |
| `npm run trace:analyze` | 分析追踪日志 |

### CLI 运行参数

- `dcode -p "任务"` — 无头模式执行任务
- `dcode -c` — 继续上次会话
- `dcode -r <sessionId>` — 恢复指定会话
- `dcode --model <name>` — 指定模型
- `dcode -y` — 自动批准所有权限（无头）
- `dcode --cwd <path>` — 指定工作目录

## 构建说明

- 使用 **esbuild** 将 `src/cli.tsx` 及其依赖打包为单文件 `dist/cli.js`
- 产物是带 shebang 的 ESM 单文件，可直接 `node dist/cli.js` 或全局安装后 `dcode`
- 静态资源（assets/ 下的音效 WAV）自动复制到 dist/assets/
- `build-stubs/react-devtools-core.js` 为空占位，避免 Ink 开发依赖
- 构建时注入 `createRequire` 兼容被打包的 CJS 依赖

## 代码风格与约定

- **语言**：TypeScript 严格模式（`strict: true`），ES2022 目标，ESNext 模块
- **JSX**：`react-jsx` 自动运行时
- **命名**：camelCase（变量/函数），PascalCase（类型/类/组件），kebab-case（文件名）
- **导入**：使用 `.js` 扩展名的 ESM 导入（TypeScript 编译后保留）
- **注释**：每个模块顶部有文件头注释（含模块职责说明），标注「制作人：Moriarty_Dox」
- **测试**：文件名 `*.test.ts`，与被测文件同目录，用 Vitest
- **结构原则**：单一职责，每个模块一个功能；核心类型集中在 `core/types.ts`
- **Provider 模式**：通过 `providers/registry.ts` 注册，`factory.ts` 创建客户端
- **错误处理**：工具返回 `ToolResult`（含 `isError` 标记），不抛异常
- **文档注释**：JSDoc 风格用于导出函数/类型，内部逻辑用行内注释

## 注意事项

1. **记忆文件**：本项目 DCODE.md 即为项目级记忆，自动注入系统提示；全局记忆在 `~/.dcode/DCODE.md`
2. **配置**：用户配置在 `~/.dcode/config.json`，环境变量优先级更高
3. **API Key**：DeepSeek 用 `DEEPSEEK_API_KEY`，智谱用 `ZHIPU_API_KEY`，OpenAI 用 `OPENAI_API_KEY`
4. **默认模型**：`deepseek-v4-flash`（配置文件默认），智谱默认 `glm-4-flash`
5. **上下文窗口**：不同模型窗口不同，超限时自动压缩（保留最近 6 条消息原文）
6. **文件检查点**：write_file/edit_file 前自动备份到 `.dcode/checkpoints/`，可用 `/undo` 回滚
7. **Shell 管理**：后台 Shell 通过 `run_command(background=true)` 启动，用 `bash_output` 轮询
8. **安全机制**：写文件/运行命令等操作默认需用户授权；`-y` 参数可绕过
9. **子代理**：`task` 工具可派生子代理，最多 5 并发，支持 `explore` 只读模式
10. **MCP**：通过 `mcp.json` 配置额外工具服务器，支持 Resources/Prompts
11. **Hooks**：`~/.dcode/hooks.json` 或项目 `.dcode/hooks.json` 配置工具生命周期钩子
12. **Skills**：`~/.dcode/skills/` 存放技能包，通过 `/skill` 命令加载
13. **会话持久化**：JSONL 格式保存在 `~/.dcode/sessions/`
14. **CI**：推送 `v*` tag 触发 GitHub Actions，自动构建 Release ZIP
15. **依赖**：`npm ci` 安装（CI 场景），日常开发 `npm install`
