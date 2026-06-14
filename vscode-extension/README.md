# DCODE for VS Code

> 在 VS Code 右侧「辅助侧边栏」中使用 DCODE AI 编程助手（像 Copilot Chat 一样停靠右侧）。
>
> 制作人：**Moriarty_Dox**

本扩展把 [DCODE](https://github.com/Nikola1ce/DCODE) 终端 AI 助手带进 VS Code：在右侧辅助侧边栏与 AI 对话、在资源管理器右键把**文件或文件夹**一键加入上下文、选中代码右键「加入上下文 / 解释 / 修复 / 重构」，并在 IDE 内对写文件 / 执行命令逐次授权。扩展**完整复用 DCODE CLI 内核**（工具系统、MCP、Hooks、文件检查点、多 Provider、上下文压缩），自身不重复实现任何 Agent 逻辑。

> 对话面板默认出现在 VS Code 右侧的「辅助侧边栏」（Secondary Sidebar）。该贡献点需要 **VS Code ≥ 1.106**；如未看到面板，可用 `Ctrl/Cmd+Alt+B` 打开辅助侧边栏，或在命令面板执行 **View: Toggle Secondary Side Bar**。

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

## 安装

**方式一：安装 .vsix（推荐，自带内核开箱即用）**

```bash
cd vscode-extension
npm install
npm run package        # 生成 dcode-vscode.vsix（已内置 dcode 内核，无需另装）
```

然后在 VS Code 中安装该 `.vsix`：
- 命令行：`code --install-extension dcode-vscode.vsix`
- 或 GUI：扩展面板右上角「…」→「从 VSIX 安装…」→ 选择 `dcode-vscode.vsix`

> `npm run package` 会自动构建扩展、构建主项目内核并把 `dist/cli.js` 一并打进 `.vsix`，因此安装后无需再全局安装 `dcode`。仍需配置 API Key（见下文）。

**方式二：开发调试（F5）**

```bash
cd vscode-extension
npm install
npm run build          # 或 npm run watch
# 主项目根也执行一次 npm run build，开发态会自动探测 ../dist/cli.js
```

在 VS Code 打开本仓库后按 `F5` 启动「扩展开发宿主」窗口加载调试。

## 前置条件

- VS Code `^1.106.0`（对话面板默认停靠右侧辅助侧边栏，依赖 1.106 引入的 `secondarySidebar` 贡献点）
- 已安装 Node.js（扩展用它运行内核）
- 一个可用的 DCODE 后台内核（三选一，按优先级自动探测）：
  1. 设置 `dcode.cliPath` 指向 `dcode` 可执行文件或内核 `cli.js`；
  2. 环境变量 `DCODE_CLI_PATH`；
  3. 随扩展打包的 `dist/cli.js`，或全局安装的 `dcode` 命令。
- 已配置 LLM API Key（默认智谱 AI 免费模型）。可在终端运行 `dcode` 后用 `/login` 配置，或设置相应环境变量（如 `ZHIPU_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`）。配置存于 `~/.dcode/config.json`，扩展会自动复用。

## 功能

- **右侧辅助侧边栏对话面板**：默认停靠在 VS Code 右侧「辅助侧边栏」（像 Copilot Chat），流式显示回答与思维链，Markdown 渲染，工具调用以可折叠卡片展示实时进度。可拖到主侧栏或重置位置。
- **点击切换模型 / 供应商 / 权限模式**（类似 Cursor）：面板顶部状态栏有三个可点击「药丸」——**供应商**、**模型**、**权限模式**。点击任一即弹出下拉选择器，带 ✓ 标记当前项与一句话说明，选中即时切换并由后台内核复用 `/model`、`/provider`、`/plan` 等同一套逻辑生效并持久化到 `~/.dcode/config.json`。供应商若未配置 Key，菜单会标注「未配置 Key」，提示你先 `/login` 或设置环境变量。
- **文件 / 文件夹加入上下文**（类似 Cursor）：三种入口任选——① 在**资源管理器右键**任意文件或文件夹 → **DCODE: 加入 DCODE 上下文**（支持 Ctrl/框选多选）；② 点击输入框下方 **+ 文件** / **+ 文件夹** 按钮通过原生选择器挑选。所选项以「上下文 chips」形式加入本轮上下文；发送时只把**文件相对路径**告诉模型，由模型按需用 `read_file` 自行读取（更省 token）。chips 可单独移除；文件夹会浅层展开其直接子文件，自动跳过二进制/超大（> 2MB）文件，单次最多 50 个。
  > 早期版本曾支持「把文件从资源管理器拖进面板」，但 VS Code Webview 出于安全会清洗拖放数据（多数平台拿不到文件 URI、不可靠），现已彻底移除拖放交互，统一改用上述 100% 可靠、可发现的右键 / 按钮入口。
- **斜杠命令**（复用 CLI 命令系统）：在输入框输入 `/` 即**立即弹出命令补全菜单**（`↑/↓` 选择、`Tab` 补全、`Enter` 执行、`Esc` 关闭），支持 `/help`、`/model`、`/provider`、`/cost`、`/config`、`/commit`、`/pr`、`/review`、`/mcp`、`/skills`、`/compact`、`/clear` 等。菜单采用「前端内置兜底 + 内核增强」：内核未就绪时也能即时显示命令列表，内核在线时再补充模型列表、MCP、子选项等更准确的候选。命令由后台内核复用 `runSlashCommand` 执行：
  - 本地命令（如 `/help`、`/cost`、`/config`、`/clear`）直接在面板内返回结果；
  - 会触发 Agent 的命令（如 `/init`、`/commit`、`/review`）自动转为一轮对话执行，可看到工具调用与权限弹窗；
  - 终端专属交互（`/login`、`/resume`、`/theme`、`/exit`）在面板内给出引导提示（如改用环境变量 / 设置 / 终端）。
- **代码块一键落地**：助手回复里的每个代码块右上角带 **复制 / 预览 diff / 应用** 三个按钮：
  - **应用**：把代码写入当前编辑器——有选区则替换选区，无选区则替换整个文件（整文替换前会确认）；
  - **预览 diff**：在并排 diff 中对比「当前文件 ↔ 应用后内容」，确认无误后再回到对话点应用；
  - **复制**：复制代码到剪贴板。
- **IDE 内权限授权**：写文件 / 执行命令时弹出「允许一次 / 总是允许 / 拒绝」卡片（受权限模式影响）。
- **资源管理器右键菜单**（文件 / 文件夹）：
  - **DCODE: 加入 DCODE 上下文**：把右键命中的文件，或文件夹（浅层展开其直接子文件）加入对话上下文；支持 Ctrl / 框选多选，自动跳过二进制与超大文件、转为相对路径 chips 回填到面板。
- **编辑器右键菜单**（选中代码后）：
  - **DCODE: 加入上下文**（置于菜单第一位）：把选区作为「上下文 chip」附件加入对话（类 Cursor），以可移除的 chip 形式携带、随下一轮发送，更省 token；发送时只把「文件路径 + 行号范围 + 代码片段」交给模型聚焦。
  - **DCODE: 解释选中代码**
  - **DCODE: 修复选中代码**
  - **DCODE: 重构选中代码**
  - **DCODE: 将选中代码加入对话**（把代码文本注入输入框，不自动发送）
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

## 常见问题

### 活动栏（最左侧竖排）看不到 DCODE 图标，但能点击切换到面板

这是 **VS Code 1.123 / 1.124 自身的已知回归**：活动栏图标「看不见但可点击」，会同时影响多个扩展（不止 DCODE），并非本扩展配置问题。可按以下任一方式处理：

1. **升级 VS Code**：该回归已在后续稳定版修复，更新到最新版（或 Insiders）即可恢复；
2. **本地窗口验证**：该问题在 Remote-SSH / Dev Container 会话中更易出现，先在本地窗口确认是否仍存在；
3. **重载窗口**：`Ctrl+Shift+P` → `Developer: Reload Window`，或关闭 GPU 加速（`--disable-gpu`）后重启再观察；
4. 图标本身已优化为「实心字母 D」并适配 VS Code 的 mask 渲染（深/浅色主题、16px 下都清晰），升级后将正常显示。

## 许可证

MIT · 制作人 **Moriarty_Dox**
