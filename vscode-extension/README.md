# DCODE for VS Code

> 在 VS Code 侧边栏中使用 DCODE AI 编程助手。
>
> 制作人：**Moriarty_Dox**

本扩展把 [DCODE](https://github.com/Nikola1ce/DCODE) 终端 AI 助手带进 VS Code：在侧边栏与 AI 对话、选中代码右键「解释 / 修复 / 重构」，并在 IDE 内对写文件 / 执行命令逐次授权。扩展**完整复用 DCODE CLI 内核**（工具系统、MCP、Hooks、文件检查点、多 Provider、上下文压缩），自身不重复实现任何 Agent 逻辑。

## 工作原理

扩展通过子进程方式启动 `dcode --ide-server`，二者经子进程的 **stdin/stdout** 以「换行分隔 JSON（NDJSON）」双向通信：

```
┌─────────────────────────────┐     NDJSON over stdio      ┌──────────────────────┐
│ VS Code 扩展                 │  ←───────────────────────→ │ dcode --ide-server    │
│  · 侧边栏 WebView 对话面板    │   prompt / 权限回执 ...     │  · 复用 Agent 主循环   │
│  · 右键 Explain/Fix/Refactor │   text / tool / 权限请求 ... │  · 工具 / MCP / Hooks  │
└─────────────────────────────┘                            └──────────────────────┘
```

- 服务端把现有的 `AgentRunEvent`（文本增量、工具开始/进度/结束、思维链等）序列化转发给扩展；
- 权限请求通过「服务端 → 扩展弹卡片 → 用户决策 → 回执服务端」往返，实现 IDE 内逐次授权；
- 协议定义见内核 `src/ide/protocol.ts` 与扩展 `src/protocol.ts`（两份保持字段一致）。

## 前置条件

- VS Code `^1.85.0`
- 已安装 Node.js（扩展用它运行内核）
- 一个可用的 DCODE 后台内核（三选一，按优先级自动探测）：
  1. 设置 `dcode.cliPath` 指向 `dcode` 可执行文件或内核 `cli.js`；
  2. 环境变量 `DCODE_CLI_PATH`；
  3. 随扩展打包的 `dist/cli.js`，或全局安装的 `dcode` 命令。
- 已配置 LLM API Key（默认智谱 AI 免费模型）。可在终端运行 `dcode` 后用 `/login` 配置，或设置相应环境变量（如 `ZHIPU_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`）。配置存于 `~/.dcode/config.json`，扩展会自动复用。

## 功能

- **侧边栏对话面板**：流式显示回答与思维链，Markdown 渲染，工具调用以可折叠卡片展示实时进度。
- **IDE 内权限授权**：写文件 / 执行命令时弹出「允许一次 / 总是允许 / 拒绝」卡片（受权限模式影响）。
- **右键三件套**（选中代码后）：
  - **DCODE: 解释选中代码**
  - **DCODE: 修复选中代码**
  - **DCODE: 重构选中代码**
  - **DCODE: 将选中代码加入对话**（仅注入，不自动发送）
- **命令面板**：打开对话面板、新建会话（清空上下文）、重启后台内核。
- **复用工作区**：以当前工作区为工作目录，文件操作直接作用于你的项目。

## 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `dcode.cliPath` | `""` | dcode CLI 路径或命令。留空则自动探测。 |
| `dcode.permissionMode` | `acceptEdits` | 权限模式：`default`（逐次确认）/ `acceptEdits`（自动编辑、命令仍确认）/ `plan`（只读）/ `bypass`（跳过确认，危险）。 |
| `dcode.model` | `""` | 覆盖默认模型（如 `deepseek-v4-pro`、`glm-4-flash`）。留空用 `~/.dcode/config.json`。 |
| `dcode.showThinking` | `true` | 是否展示推理模型的思维链。 |
| `dcode.autoStart` | `true` | 打开 VS Code / 首次打开面板时自动启动后台内核。 |

> 关于权限：本扩展沿用「子进程 + NDJSON」形态，并在此之上实现了 IDE 内逐次授权。`default` 模式下写文件 / 执行命令会弹卡片确认；若希望全自动可切到 `acceptEdits`（自动放行文件读写、命令仍确认）或 `bypass`（全部放行，仅在完全信任时使用）。

## 开发与构建

```bash
# 在扩展目录
cd vscode-extension
npm install
npm run build        # 用 esbuild 打包到 dist/extension.js
npm run watch        # 监听构建（开发时）
npm run typecheck    # 类型检查

# 打包为 .vsix（需先 build；会随包带上 media/ 与 dist/extension.js）
npm run package
```

在 VS Code 中按 `F5`（或「运行扩展」）可启动一个加载本扩展的开发宿主窗口进行调试。

> 提示：开发态下，扩展会自动探测主项目 `../dist/cli.js` 作为内核；请确保已在主项目根执行过 `npm run build`。

## 许可证

MIT · 制作人 **Moriarty_Dox**
