# DCODE Desktop 设计方案

> 状态：实施中（进度与续接入口见下方；未勾选项均未验收）
> 日期：2026-11-01（v3：增加与 Claude 桌面端的对比、宿主工具机制，细化 M1/M2/M3 开发内容）
> 范围：命令行版本地安装修复 + 桌面端 M1（首个可用版本）、M2（效率）、M3（扩展与多端）

## 实施进度（每完成一个可验证步骤立即更新）

> 更新日期：2026-11-04。`[x]` 表示实现并通过所列验证；`[ ]` 表示未验收。部分完成的工作包保留未勾选，以下细项和记录为准。
> 续接规则：先读本节、检查 `git status`，从“当前入口”继续；不要把未执行的手动/跨平台验收当作通过。

### 工作包

- [x] 准备：核对现有实现，建立进度记录；仅将本方案从 `docs/` 忽略规则中排除。
- [ ] M0：命令行版本地安装修复（脚本、构建、本地安装、冒烟验证）。
  - [x] 修复安装脚本：复制资源、写入 ESM 包清单、读取源码/发布包版本；隔离安装与更新器回归 16/16 通过。
  - [ ] 真实本地安装、已安装 CLI 冒烟及人工交互验收。
- [x] 用户追加：取消主会话与子代理默认的单轮工具调用次数上限；保留停止/取消、错误处理与并发限制。子代理并发上限 5 不变。
- [x] M1-01：协议 v5 核心扩展。
  - [x] 握手能力声明、推理强度、历史快照、轮次元数据、工具参数/改动文件、结构化权限。
  - [x] 检查点身份隔离、结构化 diff 和按 id 回退。
  - [x] 协议/服务端测试与旧客户端兼容验证（v4 帧仍可解码，桌面端对 v4 标记受限能力）。
- [x] M1-02：宿主工具注册、调用、权限、取消/超时与测试（连接私有注册表，权限不可被 bypass 绕过）。
- [x] M1-03：消息 id/turnId 持久化、消息级回退、分叉与测试。
- [ ] M1-04：桌面工程、主窗口、内核进程管理、安全 preload。
  - [x] 独立 `desktop/` 工程、Electron 主进程/preload/渲染进程、Electron 内置 Node 启动内核、NDJSON 有界帧、握手超时、异常退出状态、取消与回收、不重放 prompt。
  - [x] 安全边界：contextIsolation + sandbox、白名单 IPC、工作目录 realpath 授权、渲染进程不接触配置/密钥。
  - [x] 最小欢迎/对话页：原生选目录、流式消息、停止、仅绑定 permissionId 的审批卡片。
  - [x] 桌面单测 70/70、类型检查与构建通过。
  - [ ] GUI 实机手动验收（真实窗口、真实 API Key、权限弹窗交互、异常退出恢复）。
- [ ] M1-05：文件、Git、会话、用量、原生对话框主进程服务与测试。
- [ ] M1-06：欢迎页、项目/会话列表及其状态管理。
- [ ] M1-07：聊天工作台、工具/权限卡片、模型/推理强度切换。
- [ ] M1-08：文件树、文件预览、Diff/改动与检查点回退。
- [ ] M1-09：Git 面板与用量看板。
- [ ] M1-10：设置页与共享配置/密钥的安全处理。
- [ ] M1-11：计划模式、任务面板、结构化提问、图形登录。
- [ ] M1-12：系统集成、托盘/通知、主题与状态持久化。
- [ ] M1-13：Windows/macOS 打包、安装/卸载与首次运行向导。
- [ ] M1-14：端到端、故障恢复、性能/安全测试及使用文档。
- [ ] M2：按第 7.3 节顺序实施并逐项补充验收记录。
- [ ] M3：按第 7.4 节顺序实施并逐项补充验收记录。

### 当前入口

- 下一步从 M1-05 开始（文件、Git、会话、用量主进程服务）；M1-04 只剩 GUI 实机手测。
- M0 只剩真实本地安装与人工冒烟；安装脚本本身已通过隔离回归。

### 完成记录

- 2026-11-04／M1-01～03 与桌面骨架：
  - 内核：`npm run typecheck` 通过；`npm test` **73 个测试文件、953 通过、2 跳过**。
  - 桌面：`npm run desktop:test` **7 个文件、70 通过**；`typecheck` 与 `build` 通过（main/preload/renderer 产物）。
  - 根目录新增脚本：`desktop:build`、`desktop:test`、`desktop:start`。
  - 真实产物冒烟：`node dist/cli.js --ide-server` 返回 `protocolVersion: 5` 与 9 项 capabilities；`request_history` 正常返回且不含 system 消息。
  - 新增/改写文件：`src/ide/hostTools.ts`、`src/ide/server.desktop.test.ts`、`src/ide/hostTools.test.ts`、`src/core/sessionHistory.ts`、`src/core/sessionActions.ts`、`src/core/sessionHistory.test.ts`、`src/core/checkpoint.session.test.ts`、`src/tools/fileToolsCheckpoint.test.ts`、`src/core/windowsInstaller.test.ts`、`desktop/**`。
- 2026-11-04／追加需求：删除 `MAX_AGENT_ITERATIONS=50` 与 `MAX_SUBAGENT_ITERATIONS=30`，`AgentRunner` 默认无固定上限；显式预算接口仅保留给测试/嵌入方。`npm run test -- src/core/agentRunner.test.ts src/core/agentState.test.ts` 与全量 953 项通过；CLI/TUI/IDE 共用此内核。当前运行中的旧进程不会热替换，需构建并重启后生效。
- 2026-11-04／M0 脚本：`install-windows.ps1` 兼容 PowerShell 5.1；脚本为 UTF-8 BOM，生成的 `package.json` 为无 BOM UTF-8。`npm run test -- src/core/windowsInstaller.test.ts src/core/updater.test.ts` 16/16 通过；类型检查和完整脚本语法检查通过。隔离测试不修改真实 PATH/快捷方式，真实安装另行记录。
- 2026-11-04／准备：工作区初始干净；已读取方案与 `protocol.ts`、`server.ts`、`agent.ts`、`types.ts`、`checkpoint.ts` 及服务端测试，确认协议当前为 v4。

---

## 1. 背景与目标

DCODE 目前以终端（Ink）和 VS Code 扩展两种形态提供服务。为了让不熟悉终端的用户也能使用，并提供改动审阅、文件、Git、用量等可视化工作区，计划做一个独立的桌面应用 **DCODE Desktop**。

参照对象有两个：

- 开源项目 [DeepSeek Harness Desktop](https://github.com/ningbainb/deepseek-harness-desktop)（下称 DSH Desktop）：Electron 外壳、安装包内置运行时、对话工作台、文件树与预览、Git 面板、模型与推理强度切换、用量看板、Skills/插件、任务看板、手机远程、皮肤与桌宠等。
- Claude 桌面应用的 Code 标签页（下称 Claude 桌面端）：会话独立 worktree、PR 与 CI、内置浏览器预览、计划模式、结构化提问、多会话协作、云端运行等（对比见第 8.2 节）。

**目标不是功能数量对齐，而是在“用 AI 写代码”这件事上更好用**：更稳、更快、更少打断，改动看得清、撤得回，花费算得明白。

### 已确认的取舍

| 事项 | 结论 |
| --- | --- |
| 技术栈 | Electron + React |
| 首版范围 | 对话 + 工作区（详见第 9 节 M1） |
| 代码位置 | 本仓库 `desktop/` 目录，与 `vscode-extension/` 并列 |
| 命令行版本地安装 | 使用项目自带的 `release/templates/install-windows.ps1` |

## 2. 竞品分析：DSH Desktop 用户的真实痛点

以下来自其 GitHub Issues（2026-11 查阅），按影响面归类：

| 类别 | 用户反馈（Issue） | 我们的对策 |
| --- | --- | --- |
| 升级与安装 | 安装新版总提示文件被占用，旧版卸不掉（#8，10 条讨论，多个版本反复出现）；更新后无法选择安装位置（#44） | 安装/升级前由安装器和应用协同结束所有实例及内核进程树；每次发版在 CI 中实测“上一版 → 新版”覆盖安装与卸载 |
| 启动 | 启动卡在 8% 闪屏，运行时经 PowerShell 隐藏窗口包装后异常退出（#33、#34）；启动时报“损坏”（#90） | 内核直接由 Electron 自带 Node 启动，不经过任何 Shell 包装；启动各阶段可见，超时后给出诊断与一键修复 |
| 长会话 | 升级 4.0 后历史对话加载失败，原因是传输单帧上限 512 KiB（#83、#84） | 历史分页传输，单条消息过大时分块；以 10 MB 会话文件作为验收用例 |
| 界面 | 拓展坞打开后关不上（#79）、更新后卡死（#78）；右侧面板关闭按钮被遮挡（#64）；客户端变灰、按钮无响应（#88） | 固定三栏布局，不使用叠加浮层和独立“拓展坞”窗口；任何面板可用 Esc 或快捷键关闭 |
| 信息呈现 | Token 统计栏零散，需点开才能看到消耗与缓存（#86）；子代理显示无法关闭 | 统一底部状态栏，悬停即显示明细；所有附加信息可折叠 |
| 状态一致性 | 切换模型后推理强度档位残留，触发 `UNSUPPORTED_REASONING_EFFORT`（#93、#95）；预设切换后路由与界面不一致（#98） | 推理强度按模型能力归一；切换模型时界面自动收敛到该模型支持的档位，界面状态以内核 `status` 为唯一来源 |
| 配置安全 | 切换皮肤污染全局配置，导致 Web 启动失败（#26）；初次配置后找不到修改入口，“打开配置文件”无响应 | 桌面端只写入自己负责的配置字段，写前备份；所有设置都有可见入口，可随时修改 |
| 会话管理 | 归档的对话无法找回（#36） | 会话归档、恢复与全文搜索 |
| 扩展 | 插件市场目录超 1 MB 全部插件无法加载；多个版本插件不可用 | M1 不做插件市场；扩展统一走内核已支持的标准 MCP 与 Skills |

## 3. 设计原则

1. **专注编码工作流**：一个窗口、三栏布局完成全部核心操作。不做桌宠、皮肤市场、浮动拓展坞等与写代码无关的负担。
2. **改动可审阅、可撤销**：Agent 的每一轮改动都能整体查看 diff、按文件或按块回退、一键撤销整轮。
3. **少打断**：按风险分级审批，低风险不打扰，高风险醒目；窗口在后台时用系统通知提醒。
4. **成本透明**：发送前能估算，发送后看得到实际花费和缓存命中，可设预算上限。
5. **稳定第一**：启动、升级、长会话、内核崩溃都有明确的保护和恢复路径。
6. **键盘优先**：所有高频操作都有快捷键，命令面板覆盖全部功能。
7. **三端共享**：终端、VS Code 扩展、桌面端使用同一份配置与会话，可在任一端继续另一端的会话。

## 4. 核心体验设计（差异化）

### 4.1 审阅优先的改动流程

- 每轮结束时在对话中生成 **“本轮改动”卡片**：列出改动的文件及增删行数，并提供“审阅”“撤销本轮”两个按钮。
- **审阅视图**：左侧文件列表，右侧并排 diff（CodeMirror merge）。支持按文件回退、按代码块（hunk）回退，回退前同样写入检查点，可再次撤销。
- 权限模式为“自动接受编辑”时，改动先落盘、事后审阅；为“默认”时，权限卡片内直接显示并排 diff，审批前即可看清改动。
- 检查点按 **会话 + 轮次** 归档，“撤销本轮”只影响该轮，不会误撤其他会话的改动。

### 4.2 智能审批

- **风险分级**：
  - 低：只读操作（读文件、搜索）自动执行；
  - 中：工作区内的文件编辑，可设为自动接受（因为可撤销）；
  - 高：执行命令、联网、MCP 工具需要确认；命中危险模式（如 `rm -rf`、`Remove-Item -Recurse`、`format`）时用红色警示并要求二次确认。
- **批量授权**：除“允许一次 / 始终允许 / 拒绝”外，增加“本轮内允许同类操作”，避免长任务中反复点击。
- **快捷键**：审批卡片出现时，`Y` 允许一次、`A` 始终允许、`T` 本轮允许、`N` 拒绝。
- **后台提醒**：窗口失焦时，需要审批或任务完成会弹出系统通知并闪烁任务栏，点击通知直达对应会话。
- **规则管理**：设置页列出所有“始终允许”规则，可查看和删除。

### 4.3 成本透明

- 输入框下方实时显示 **发送前估算**：本次请求的输入 token 数与预估费用（含缓存命中后的折算）。
- 统一状态栏：模型、上下文占用条、缓存命中率、本会话与今日的输入/输出 token 和费用；**悬停即显示明细**，点击展开按轮的用量表。
- **预算上限**：可设置单会话、每日、每月上限，达到 80% 提醒，达到 100% 暂停并询问是否继续。
- M2 起显示供应商账户余额（如 DeepSeek 余额接口）。

### 4.4 键盘优先

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+K` | 命令面板：切换会话、模型、推理强度、权限模式，打开文件，执行斜杠命令 |
| `Ctrl+N` | 新建对话 |
| `Ctrl+P` | 快速打开文件（预览） |
| `Enter` / `Shift+Enter` | 发送 / 换行（可在设置中互换） |
| `Esc` | 停止当前回合；关闭面板或弹层 |
| `Alt+↑` / `Alt+↓` | 切换上一个 / 下一个会话 |
| `Ctrl+Shift+R` | 打开本轮改动审阅 |
| `Ctrl+Z`（审阅视图中） | 撤销最近一次回退 |

### 4.5 上下文可见、可控

- 输入框上方以标签形式显示本次附带的上下文：`@文件`、选中的代码片段、拖入的文件；可单独移除。
- 上下文占用接近自动压缩阈值时提示，并提供“立即压缩”按钮；压缩前后在对话中显示分隔说明。
- 推理强度选择器只显示当前模型支持的档位，并标注各档位的相对耗时与成本。

### 4.6 稳定与恢复

- **草稿自动保存**：输入框内容实时保存，重启后恢复。
- **内核崩溃恢复**：内核异常退出时自动重启（同一会话 `-r` 恢复），在对话中提示“上一轮被中断”，并提供“继续”按钮。
- **可操作的错误卡片**：网络失败 → 打开代理设置；401 → 更新 API Key；402 → 前往充值；429 → 显示倒计时并自动重试；超出上下文 → 一键压缩后重试。
- **一键诊断**（M2）：检查网络与代理、API Key 有效性、模型可用性、Git 是否可用，导出脱敏的诊断报告。

### 4.7 60 秒上手

- 自动检测已有的 `~/.dcode/config.json` 与环境变量中的 API Key：已经用过命令行版的用户零配置直接进入。
- 新用户三步引导：选择供应商 → 填写 API Key（带获取链接，提交前在线校验）→ 选择项目文件夹。
- 首个对话提供几条与当前项目相关的示例提问（如“解释这个项目的结构”“运行测试并修复失败项”）。

### 4.8 会话管理

- 会话按工作区分组，标题取首条用户消息，可重命名、置顶、归档、删除（删除需确认，归档可恢复）。
- **全文搜索**所有会话（主进程流式扫描 `~/.dcode/sessions/*.jsonl`）。
- 终端里开始的会话可在桌面端继续，反之亦然。

### 4.9 计划模式与审批

- 复杂任务可先进入计划模式：Agent 只读调研，产出一份计划文档（Markdown），在右侧面板展示。
- 用户可“批准并执行”“修改意见后重写”或“放弃”；批准时可同时选择执行阶段的权限模式（默认 / 自动接受编辑）。
- 计划文档随会话保存，执行过程中可随时对照；执行结束后在收尾卡片中标注计划内各步骤的完成情况。

### 4.10 结构化提问

- Agent 需要用户做决定时（方案选择、需求歧义），通过 `ask_user` 宿主工具弹出**问题卡片**：问题 + 2–4 个选项（可标注推荐项）+ “其他”自由输入，可多选。
- 支持键盘数字键选择；窗口在后台时发送通知。
- 回答作为工具结果返回给 Agent，避免“Agent 用文字问、用户用文字答、Agent 再理解”的往返。

### 4.11 回合收尾与对话回退

- **收尾卡片**：每个回合结束时，在对话末尾显示简短回顾（助手最后一段总结）与**下一步按钮**，按钮由桌面端根据实际状态生成：有未提交改动 → “提交”；分支领先远端 → “推送 / 创建 PR”；项目有测试脚本 → “运行测试”；本轮有改动 → “审阅改动”。
- **对话回退**：在任意一条用户消息上选择“回退到此处”，对话与该消息之后的文件改动一并回滚（基于按轮检查点），原输入回填到输入框便于修改后重发。
- **分叉**：从任意消息“分叉为新会话”，复制此前的对话到新会话，原会话保持不变，适合尝试另一种方案。

## 5. 体验指标（验收标准）

| 指标 | 目标 |
| --- | --- |
| 冷启动到可输入 | ≤ 2.5 秒（中端 Windows 笔记本） |
| 内核就绪（`ready`） | ≤ 1.5 秒 |
| 首 token 额外延迟（相对命令行版） | ≤ 50 毫秒 |
| 流式渲染 | 主线程单次长任务 < 50 毫秒；1 万条消息会话滚动 ≥ 50 fps |
| 长会话 | 10 MB 会话文件 1 秒内显示最近一屏 |
| 空闲内存 | 单工作区 ≤ 300 MB |
| 升级 | 上一版 → 新版覆盖安装成功率 100%，配置与会话零丢失（CI 实测） |
| 审批操作 | 从审批卡片出现到处理完成，全程可只用键盘 |

## 6. 现状与可复用资产

- **内核服务模式**：`dcode --ide-server` 通过 stdin/stdout 收发 NDJSON，协议版本 4（`src/ide/protocol.ts`、`src/ide/server.ts`）。VS Code 扩展即以此驱动内核（`vscode-extension/src/dcodeClient.ts`）。
- **协议缺口**：没有会话历史回放、待办事件、上下文与缓存用量、推理强度设置、检查点/撤销、结构化 diff、轮次标识；`run_start`、`llm_start`、`compact_*` 等事件在 `server.ts` 中被丢弃。
- **可直接复用的内核模块**：会话 `src/core/session.ts`（`listSessions`、`loadSessionMessages`）、配置 `src/config.ts`（`loadConfig`、`updateConfig`）、供应商与模型 `src/providers/registry.ts`、忽略规则 `src/core/ignore.ts`、路径校验 `src/tools/util.ts`（`resolveWithinCwd`）、检查点 `src/core/checkpoint.ts`、上下文估算 `src/core/contextUsage.ts`、计费 `src/providers/pricing.ts`、MCP 配置 `src/mcp/config.ts`、危险命令识别（`src/tools/runCommand.ts` 中的 `DANGEROUS_PATTERNS`）。
- **安装脚本问题**：`install-windows.ps1` 没有复制 `dist/assets`（提示音），也没有写入 `/update` 定位包根所需的 `package.json`（`src/core/updater.ts` 按 `name=dcode` 查找）。

## 7. 技术方案

### 7.1 第 0 步：修复并执行命令行版本地安装

1. 修改 `release/templates/install-windows.ps1`：
   - 存在时复制 `dist/assets` 到 `%LOCALAPPDATA%\DCODE\dist\assets`。
   - 写入 `%LOCALAPPDATA%\DCODE\package.json`：`{"name":"dcode","version":"<源版本>","type":"module"}`。
2. 执行 `npm run build`，再运行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File release/templates/install-windows.ps1 -SourceDir <仓库根目录>
   ```

3. 验证：`%LOCALAPPDATA%\DCODE\bin\dcode.cmd --version` 输出当前版本，`dist\assets\sounds` 下有 5 个 wav 文件。
4. 注意：若本机做过 `npm link`，PATH 中 `%APPDATA%\npm\dcode` 会排在安装版之前。是否执行 `npm unlink -g dcode` 由使用者决定。

### 7.2 总体架构

```
┌────────────── Electron 主进程 (desktop/electron/main.ts) ──────────────┐
│ 窗口 / 托盘 / 通知 / 单实例锁 · CoreProcess 管理（每个运行中的会话一个内核） │
│ WorkspaceService · GitService · SessionService（列表、归档、搜索）          │
│ ReviewService（轮次改动、按文件/按块回退） · ConfigService · UpdateService │
│ IPC 白名单路由与参数校验                                                  │
└────────┬───────────────────────────────────────────────┬───────────────┘
         │ spawn(process.execPath, ELECTRON_RUN_AS_NODE=1) │ contextBridge
         ▼                                                 ▼
 resources/core/cli.mjs --ide-server            preload.ts → window.dcode
 （现有内核，NDJSON 协议 v5）                     渲染进程 React (desktop/src)
```

- **免装 Node、无 Shell 包装**：用 Electron 自带的 Node 直接运行内核（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`），`windowsHide: true`，不经过 PowerShell 或批处理包装，规避 DSH Desktop 的启动卡死问题。
- **一个会话一个内核进程**：内核一次只跑一个回合，因此每个运行中的会话各有一个内核进程（为 M2 并行任务铺路）；空闲超过 10 分钟的内核自动退出，再次使用时按 `-r <sessionId>` 秒级恢复。
- **非 Agent 能力放在主进程**：文件树、Git、会话列表与搜索、改动审阅、配置读写由主进程实现，复用第 6 节列出的内核模块（主进程用 esbuild 打包，可直接 import `../src/**`）。
- **状态单一来源**：模型、推理强度、权限模式等以内核 `status` 消息为准，界面只做展示与发起修改，避免界面与实际路由不一致。
- **与命令行版共享数据**：`~/.dcode/config.json`、`~/.dcode/sessions/`、`<项目>/.dcode/checkpoints/`。桌面端独有的设置（窗口布局、快捷键、预算、通知）单独存放在 `~/.dcode/desktop.json`，不污染共享配置，写入前备份。

### 7.3 第 1 步：内核协议扩展到 v5

原则：**只增不改，向后兼容**；终端界面与 VS Code 扩展忽略新增字段和消息。

涉及文件：`src/ide/protocol.ts`、`src/ide/server.ts`、`src/core/types.ts`、`src/core/checkpoint.ts`、`src/tools/editFile.ts`、`src/tools/writeFile.ts`、`src/tools/runCommand.ts`、`src/ide/server.test.ts`。

**客户端 → 服务端（新增）**

| 消息 | 字段 | 作用 |
| --- | --- | --- |
| `set_effort` | `effort` | 设置推理强度并持久化；不被当前模型支持时归一到最近的可用档位并在 `status` 中回报 |
| `history_request` | `cursor?`、`limit` | 分页拉取历史（解决长会话单帧过大） |
| `list_checkpoints` | `queryId`、`turnId?` | 列出检查点，可按轮次过滤 |
| `undo_turn` | `turnId` | 撤销某一轮的全部文件改动 |
| `undo` | `count` | 撤销最近 N 个检查点（兼容 `/undo`） |
| `estimate` | `queryId`、`text` | 估算发送该输入的 token 与费用（复用 `estimateRequestTokens` 与计费模块） |

**服务端 → 客户端（新增或扩展）**

| 消息 | 字段 | 作用 |
| --- | --- | --- |
| `ready` / `status`（扩展） | 增加 `reasoningEffort`、`supportedEfforts`、`contextWindow`；`protocolVersion: 5` | 初始化选择器、上下文占用条 |
| `history_page` | `messages`、`nextCursor?` | 历史分页；单条消息超过 256 KiB 时内容分块下发 |
| `turn_start` | `requestId`、`turnId` | 轮次开始 |
| `turn_done`（扩展） | 增加 `turnId`、`changedFiles [{path, added, removed}]` | 生成“本轮改动”卡片 |
| `todos` | `items` | `todo_write` 结束后下发 `agent.getTodos()` |
| `llm_usage` | `requestId`、`promptTokens`、`completionTokens`、`cacheHitTokens`、`contextTokens`、`costUsd` | 逐次用量，用于状态栏与预算 |
| `compact` | `phase: start\|end`、`applied?`、`beforeTokens?`、`afterTokens?` | 压缩状态与效果 |
| `tool_start`（扩展） | 增加可选 `input`（截断后的参数 JSON） | 显示目标文件，写文件后刷新面板 |
| `permission_request`（扩展） | 增加 `risk: low\|medium\|high`、`category: edit\|command\|network\|mcp\|other`、`fileDiff?` | 风险分级与并排 diff |
| `checkpoints` / `undo_result` / `estimate_result` | 对应请求的结果 | |

**宿主工具（Host Tools）**

现有工具都在内核进程中执行，内核无法调用桌面端的能力。内置浏览器、读取用户终端、结构化提问、计划审批等都需要“由宿主执行的工具”，因此 v5 增加一套反向调用机制，M1 即落地（后续功能只需注册新工具，不再改协议）：

| 方向 | 消息 | 字段 | 作用 |
| --- | --- | --- | --- |
| 客户端 → 服务端 | `register_host_tools` | `tools [{name, description, parameters, readOnly, risk}]` | 宿主声明自己提供的工具；可在运行中增删 |
| 服务端 → 客户端 | `host_tool_call` | `callId`、`requestId`、`name`、`input` | 内核把工具调用转交宿主执行 |
| 客户端 → 服务端 | `host_tool_result` | `callId`、`content`、`isError?`、`images?` | 宿主返回执行结果 |

- 内核侧以代理工具注册（参照 `src/tools/mcpProxy.ts` 的代理方式），参与正常的权限检查、并发调度与取消；回合取消时未完成的宿主调用以 `isError` 结束。
- 宿主未连接或超时（默认 5 分钟，`ask_user` 不超时）时返回明确错误，Agent 可降级处理。
- M1 注册的宿主工具：`ask_user`（结构化提问）、`submit_plan`（提交计划等待审批）；M2 增加 `browser_*`（内置浏览器）、`read_terminal`（读取用户终端）。

**对话回退与分叉**

| 方向 | 消息 | 字段 | 作用 |
| --- | --- | --- | --- |
| 客户端 → 服务端 | `rewind` | `messageId` | 截断该消息之后的对话并撤销对应轮次的检查点，返回被回退的用户输入 |
| 客户端 → 服务端 | `fork` | `messageId` | 以该消息之前的对话创建新会话文件（`SessionRecorder.create` + 快照），返回新 `sessionId` |
| 服务端 → 客户端 | `rewind_result` / `fork_result` | 对应结果 | |

`history_page` 中的每条消息带稳定的 `messageId`，供回退、分叉与定位使用。

**其他内核改动**

- `permission_response.decision` 增加 `allow_turn`：本轮内同一工具（命令类按命令前缀）自动放行，轮次结束失效。
- 检查点条目增加 `sessionId`、`turnId` 字段（旧条目缺省视为未知轮次），实现按轮撤销且互不干扰。
- `PermissionRequest` 增加可选 `fileDiff {path, before, after}`，由 `edit_file`、`write_file` 的 `checkPermission` 填充；`risk` 由工具类别与 `DANGEROUS_PATTERNS` 判定。

**测试**：在 `src/ide/server.test.ts` 为每个新消息补充测试，包括 10 MB 会话的分页加载；确认 VS Code WebView（`vscode-extension/media/main.js`）对未知消息类型安全忽略。

### 7.4 第 2 步：`desktop/` 工程结构

```
desktop/
  package.json             # electron、electron-builder、electron-updater、vite、react 18、typescript、zustand
  electron/
    main.ts                # 生命周期、单实例锁、窗口、托盘、通知、菜单
    preload.ts             # contextBridge 暴露类型化的 window.dcode API
    coreProcess.ts         # 移植自 vscode-extension/src/dcodeClient.ts：启动、NDJSON 分帧、ready 超时、shutdown、进程树终止、崩溃重启、空闲回收
    ipc.ts                 # IPC 通道白名单 + 参数校验（路径一律经 resolveWithinCwd）
    services/
      workspace.ts         # 文件树（忽略规则）、读文件、fs.watch 防抖刷新、最近工作区
      git.ts               # git status --porcelain=v2、diff、stage / unstage / discard
      sessions.ts          # 会话列表、重命名、置顶、归档、删除、全文搜索
      review.ts            # 轮次改动汇总、按文件/按块回退（回退前写检查点）
      settings.ts          # ~/.dcode/desktop.json 读写与备份
      update.ts            # electron-updater，升级前结束全部内核进程
  src/                     # 渲染进程（React）
  build/                   # 图标、NSIS 自定义脚本（安装前结束进程）
  scripts/prepare-core.mjs # 构建内核，复制 dist/cli.js → resources/core/cli.mjs 及提示音
  e2e/                     # Playwright Electron 端到端测试与模拟供应商
  electron-builder.yml
```

- **构建**：vite 构建渲染进程；esbuild 构建 `main.ts`、`preload.ts`（CJS，`electron` 设为 external）。`npm run dev` 同时启动 vite 开发服务器和 Electron。
- **协议类型**：直接 `import type` 根目录的 `src/ide/protocol.ts`，不再复制。
- **安全**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、严格 CSP；外部链接只允许 http(s)，用 `shell.openExternal` 打开；渲染进程不能直接执行命令，也不能访问工作区以外的文件。

### 7.5 第 3 步：对话界面

技术选型：React 18 + TypeScript + Zustand（每个会话一份状态，按协议事件归约更新）+ `react-markdown` / `remark-gfm` / `highlight.js` + `react-virtuoso`（长会话虚拟列表）+ CodeMirror 6（预览与 diff）。

**固定三栏布局**（不使用浮层窗口，任何面板可用 Esc 或快捷键关闭）：

| 区域 | 内容 |
| --- | --- |
| 左侧栏 | 工作区切换；会话列表（运行中 / 等待审批 / 已完成 / 失败 状态点，置顶、归档入口）；新建对话；底部设置入口 |
| 中间对话区 | 用户消息；助手 Markdown（表格、有序列表、代码高亮、复制按钮）；思维链折叠块（流式时展开，结束后自动折叠，显示字数与耗时）；工具卡片（运行中/进度/成功/失败，可展开详情，命令输出等宽显示）；权限卡片（风险色标、命令预览或并排 diff、快捷键提示）；“本轮改动”卡片；可折叠的待办面板；压缩分隔说明；可操作的错误卡片 |
| 输入区 | 上下文标签（@文件、片段）；多行输入；`/` 命令补全；`@` 文件补全；发送前估算；停止按钮；模型、推理强度、权限模式选择器 |
| 右侧面板 | 文件 / 变更 / 审阅 / 检查点（第 7.6 节），可折叠、可拖拽宽度，宽度按工作区记忆 |
| 底部状态栏 | 模型、上下文占用条、缓存命中率、本会话与今日费用；悬停显示明细 |

- **流式性能**：按 `requestAnimationFrame` 合并增量（参考 VS Code WebView 已验证的节流实现），只重新渲染最后一条消息的 Markdown；用户向上滚动时暂停自动跟随并显示“回到最新”。
- **主题**：浅色 / 深色 / 跟随系统，一套设计令牌贯穿全部界面，保证各面板风格一致。

### 7.6 第 4 步：工作区面板与设置

- **文件**：文件树（遵循 `.gitignore` / `.dcodeignore`）、`Ctrl+P` 快速打开；预览代码、Markdown、图片；“在系统编辑器中打开”“在资源管理器中显示”。Agent 写文件后自动刷新。
- **变更**：Git 变更列表，点击显示 diff；暂存 / 取消暂存；丢弃更改需二次确认。未安装 Git 或非 Git 目录时给出说明与安装链接。
- **审阅**：按轮次查看 Agent 改动（第 4.1 节），按文件或按块回退。
- **检查点**：按会话与轮次分组的快照列表，一键撤销。

**设置页**（每一项都有可见入口，随时可改）：供应商与 API Key（提交前在线校验）、默认模型与推理强度、默认权限模式、“始终允许”规则管理、预算上限、通知、快捷键、主题、提示音、代理；MCP 服务器与 Skills 只读列表。

### 7.7 第 5 步：托盘、通知与更新

- **托盘**：关闭窗口时可最小化到托盘（首次关闭时询问）；托盘菜单显示运行中会话数，可“显示窗口”和“退出”。
- **通知**：窗口失焦时，需要审批、回合完成、回合失败都发送系统通知，点击直达会话；可在设置中按类型关闭。
- **自动更新**：electron-updater 从 GitHub Releases 检查更新，用户确认后下载；安装前先结束全部内核进程与窗口，NSIS 脚本兜底结束残留进程，避免“文件被占用”。更新内容在对话外以通知形式展示，不打断当前回合。

### 7.8 第 6 步：打包发布

- 使用 electron-builder 生成 Windows **NSIS 按用户安装包**（无需管理员权限，允许选择安装位置，升级时沿用原位置）：`DCODE-Desktop-Setup-<版本>-x64.exe`。
- `asar` 打包；`extraResources` 放入 `core/cli.mjs` 与 `assets/sounds`。
- 安装包暂不签名，首次运行会出现 SmartScreen 提示，需在发布说明中写明，并附 SHA-256。
- 卸载时保留 `~/.dcode`（配置、会话），可选“同时删除用户数据”。
- 根目录 `package.json` 增加 `desktop:dev`、`desktop:build` 脚本；`.github/workflows/release.yml` 增加桌面安装包构建与“上一版 → 新版”升级测试任务。

## 8. 竞品对比

### 8.1 与 DSH Desktop

| 维度 | DSH Desktop | DCODE Desktop |
| --- | --- | --- |
| 定位 | 全能工作台：编程、插件市场、任务看板、远程、QQ Bot、皮肤、桌宠 | 专注编码工作流，功能少而精 |
| 运行时 | 内置 Node、DSH Runtime、Git，多层包装启动 | Electron 自带 Node 直接运行内核，无 Shell 包装 |
| 改动审阅 | 文件预览与 Diff | 按轮次汇总、按文件/按块回退、一键撤销整轮 |
| 审批 | 逐次确认 | 风险分级、本轮批量允许、全键盘操作、后台系统通知 |
| 成本 | 用量看板（需点开查看） | 发送前估算、悬停明细、预算上限 |
| 长会话 | 曾因单帧上限导致历史加载失败 | 历史分页、大消息分块，10 MB 会话验收 |
| 升级 | 多个版本反复出现“文件被占用” | 应用与安装器协同结束进程，CI 实测升级路径 |
| 界面 | 侧栏 + 独立拓展坞窗口（15 个入口） | 固定三栏，无浮层，统一设计令牌 |
| 多端 | 桌面 + 手机远程 | 终端、VS Code、桌面三端共享配置与会话（手机远程在 M3） |
| 扩展 | 插件市场 | 标准 MCP 与 Skills（M3 提供管理界面） |

### 8.2 与 Claude 桌面端

依据：Claude 桌面应用 Code 标签页中实际可用的界面与能力（2026-11 观察，不同账户或版本开放的功能可能有差异）。

| 能力 | Claude 桌面端 | DCODE Desktop 对应安排 |
| --- | --- | --- |
| 会话隔离 | 每个会话可在独立 git worktree 分支上工作，多会话并行；一键同步主分支 | M2：会话默认独立 worktree、同步主分支 |
| PR 与 CI | 创建 PR，PR 面板看 CI；CI 失败、冲突、评审意见出现时自动唤醒修复；可合并 | M2：创建 PR、CI 状态；M3：CI 失败自动修复 |
| 内置浏览器预览 | 按配置启动开发服务器并在内置浏览器预览；Agent 可截图、点击、读页面来验证改动 | M2：内置浏览器 + `browser_*` 宿主工具 |
| 终端 | 用户终端面板，Agent 可读取用户刚运行命令的输出 | M2：集成终端 + `read_terminal` 宿主工具 |
| 计划模式 | 只读调研 → 计划文件 → 用户审批后执行 | M1：计划模式与审批（4.9） |
| 结构化提问 | 带选项的问题卡片 | M1：`ask_user` 问题卡片（4.10） |
| 回合收尾 | 固定任务清单；每回合结束的回顾与一键操作按钮 | M1：收尾卡片与下一步按钮（4.11） |
| 回退与分叉 | 回退到某条消息（代码与对话一起回滚）；分叉会话 | M1：回退与分叉（4.11） |
| 多会话协作 | Agent 可另开会话处理独立任务并跟踪结果；分屏；侧栏分组、置顶、未读；会话记录搜索与导出；章节目录 | M2：分屏、分组、搜索与导出；M3：Agent 派生会话 |
| 云端与远程 | 云端运行（电脑休眠也继续）；从其他设备远程控制 | M3：远程控制（局域网 + 中继）；云端运行暂不规划 |
| 定时任务 | 定时运行的任务 | M3：任务看板与定时任务 |
| 扩展生态 | 插件、技能、连接器目录，可搜索安装 | M3：Skills / MCP 管理与目录 |
| 富输出 | 生成并发布 HTML 页面，对话内渲染图表与交互组件 | M3：对话内富内容渲染与 HTML 产物预览 |
| 长任务保障 | 防止电脑休眠；完成或需审批时通知 | M1：防休眠 + 通知 |

**DCODE Desktop 的相对优势**：多家国产模型自由切换；成本透明（发送前估算、悬停明细、预算上限）；按轮次、按代码块的改动审阅与回退；终端、VS Code、桌面三端共享配置与会话；全中文界面、数据只在本机。

## 9. 里程碑与后续开发内容

总览：

| 里程碑 | 主题 | 依赖 |
| --- | --- | --- |
| **M0** | 命令行版本地安装（第 7.1 节） | 无 |
| **M1** | 首个可用版本：稳定的对话工作台 + 审阅优先 + 少打断 | M0 不阻塞 M1；M1 内协议与骨架可并行 |
| **M2** | 效率：并行会话、PR 与 CI、内置浏览器、集成终端、多会话管理 | M1 |
| **M3** | 扩展与多端：插件与连接器、任务看板与定时、远程控制、SSH、富输出、跨平台 | M2 |

工作包编号（如 `M1-03`）用于拆分任务与跟踪进度；每个工作包完成时须带测试，并通过第 11 节对应的验证。

### 9.1 M1：首个可用版本

**目标**：替代终端完成日常编码任务；在稳定性、改动审阅、审批体验、成本透明上明显优于 DSH Desktop；补上与 Claude 桌面端差距中改动小、收益大的部分。

| 编号 | 工作包 | 主要内容 | 涉及位置 |
| --- | --- | --- | --- |
| M1-01 | 协议 v5 基础消息 | 第 7.3 节中的推理强度、历史分页、轮次、待办、用量、压缩、检查点与撤销、估算、`allow_turn`、风险分级与 `fileDiff`；检查点增加 `sessionId` / `turnId` | `src/ide/**`、`src/core/types.ts`、`src/core/checkpoint.ts`、`src/tools/*` |
| M1-02 | 宿主工具机制 | `register_host_tools` / `host_tool_call` / `host_tool_result`；内核代理工具参与权限、调度与取消；首批工具 `ask_user`、`submit_plan` | `src/ide/**`、`src/tools/`（新增代理） |
| M1-03 | 回退与分叉 | `rewind`、`fork`、稳定 `messageId` | `src/ide/**`、`src/core/session.ts` |
| M1-04 | 工程骨架与内核进程管理 | 第 7.4 节结构；CoreProcess：免 Shell 启动、NDJSON、ready 超时、进程树终止、崩溃自动恢复、空闲 10 分钟回收 | `desktop/electron/` |
| M1-05 | 主进程服务 | 工作区（文件树、监听）、Git（状态、diff、暂存、丢弃）、会话（列表、重命名、置顶、归档、删除）、审阅（轮次汇总、按文件/按块回退）、桌面设置（`~/.dcode/desktop.json`，写前备份） | `desktop/electron/services/` |
| M1-06 | 对话区 | 三栏布局；Markdown 与代码高亮；思维链折叠；工具卡片；风险分级权限卡（快捷键）；问题卡片（4.10）；计划审阅（4.9）；本轮改动卡片；收尾卡片与下一步按钮（4.11）；可操作错误卡片；待办面板；压缩说明；长会话虚拟列表 | `desktop/src/` |
| M1-07 | 输入区 | 上下文标签、`/` 补全、`@` 文件补全、发送前估算、模型 / 推理强度 / 权限模式选择器（强度按模型能力收敛）、草稿自动保存 | `desktop/src/` |
| M1-08 | 右侧面板 | 文件、变更、审阅、检查点四个标签；宽度与折叠状态按工作区记忆 | `desktop/src/` |
| M1-09 | 状态栏与预算 | 统一状态栏、悬停明细、按轮用量表；单会话 / 每日 / 每月预算与 80% 提醒、100% 暂停 | `desktop/src/`、`services/settings.ts` |
| M1-10 | 设置与首次启动 | 第 7.6 节设置页；检测已有配置零配置进入；三步引导与 API Key 在线校验；示例提问 | `desktop/src/` |
| M1-11 | 快捷键与基础命令面板 | 第 4.4 节快捷键；`Ctrl+K` 首版支持切换会话、模型、推理强度、权限模式 | `desktop/src/` |
| M1-12 | 托盘、通知、防休眠 | 第 7.7 节托盘与通知；回合运行期间用 `powerSaveBlocker` 防止系统休眠（可关闭） | `desktop/electron/main.ts` |
| M1-13 | 安装包与自动更新 | NSIS 按用户安装、可选安装位置；electron-updater；升级前结束全部内核与窗口；卸载保留用户数据 | `desktop/build/`、`services/update.ts` |
| M1-14 | 测试与发布流水线 | 单元测试、模拟供应商 E2E、体验指标脚本；CI 中实测“上一版 → 新版”升级 | `desktop/e2e/`、`.github/workflows/` |

**验收标准**：

- 第 5 节全部体验指标达标。
- 第 11 节验证 1–6 全部通过。
- 用模拟供应商完整走通：计划 → 审批 → 执行 → 问题卡片 → 权限审批（全键盘）→ 本轮改动审阅 → 按块回退 → 回退到某条消息 → 分叉新会话。
- 强制结束内核进程后，会话自动恢复且未丢失任何消息。

### 9.2 M2：效率提升

**目标**：支持多个任务同时推进；让 Agent 能自己验证界面与命令结果；把“改代码 → 提 PR → 过 CI”闭环放进桌面端。

| 编号 | 工作包 | 主要内容 |
| --- | --- | --- |
| M2-01 | 并行会话与独立 worktree | Git 仓库中新建会话默认在独立分支的 worktree 工作（可关闭），worktree 位于 `~/.dcode/worktrees/<项目>/<会话>`，不污染项目目录；“同步主分支”在 worktree 内合并基线分支，冲突在审阅视图中处理；完成后“合并回主分支”或“保留分支”，并清理 worktree；同时运行的会话数可配置上限（默认 4） |
| M2-02 | PR 与 CI | 检测 `gh` 及登录状态（未安装时引导）；由 Agent 依据各轮改动起草 PR 标题与说明，用户确认后创建；PR 面板显示检查状态与评审意见（面板可见时每 60 秒刷新）；合并需二次确认 |
| M2-03 | 内置浏览器预览 | 右侧“预览”标签（Electron `WebContentsView`）；`<项目>/.dcode/launch.json` 配置开发服务器（命令、端口、URL），一键启动 / 停止并查看日志；宿主工具 `browser_navigate`、`browser_read_page`（可访问性树文本）、`browser_click`、`browser_type`、`browser_screenshot`、`browser_console`；默认只允许 localhost，其他域名需用户授权；模型不支持图像时 Agent 以页面文本代替截图 |
| M2-04 | 集成终端 | xterm.js + node-pty（Windows ConPTY，按 Electron 版本预编译原生模块）；多标签；宿主工具 `read_terminal`（返回最近 N 行，作为数据而非指令处理）；“把这段输出发给 Agent”按钮 |
| M2-05 | 多会话管理 | 两个会话分屏并排；侧栏自定义分组、置顶、未读标记；会话全文搜索；导出为 Markdown；按用户消息自动生成章节目录 |
| M2-06 | 完整命令面板 | `Ctrl+K` 覆盖全部功能与斜杠命令；快捷键自定义 |
| M2-07 | 预算与余额 | 接入供应商余额接口（如 DeepSeek 余额查询）；每日 / 每月用量报表 |
| M2-08 | 一键诊断 | 网络与代理、API Key、模型可用性、Git / gh 可用性检查；导出脱敏诊断报告 |

**验收标准**：

- 同一仓库两个会话并行修改不同文件，互不干扰，均可合并回主分支；有冲突时能在审阅视图中解决。
- 从改动到创建 PR、看到 CI 状态全程在桌面端完成。
- Agent 通过浏览器工具打开本地页面、读取内容并确认一处界面改动生效。
- `read_terminal` 能返回用户在集成终端中刚运行命令的输出。
- 1000 个会话时全文搜索 2 秒内返回首批结果。

### 9.3 M3：扩展与多端

**目标**：开放扩展能力，支持离开电脑后的远程使用与自动化，覆盖 macOS / Linux。

| 编号 | 工作包 | 主要内容 |
| --- | --- | --- |
| M3-01 | Skills 与 MCP 管理 | 列表、启用 / 禁用、从 Git 地址或本地目录安装、连接状态与日志；精选目录分片加载（避免 DSH Desktop 目录超 1 MB 全部失效的问题），第三方扩展错误相互隔离 |
| M3-02 | 任务看板与定时任务 | 看板列：待规划 / 待办 / 进行中 / 已完成 / 已失败；任务交给后台会话执行，记录运行结果（改动、命令输出、费用）；定时任务（cron 表达式）由主进程调度，应用驻留托盘时生效 |
| M3-03 | CI 失败自动修复 | 可选开启：PR 检查失败时自动在对应 worktree 开会话读取日志并修复，修复后推送；每个 PR 有次数与费用上限 |
| M3-04 | Agent 派生会话 | 宿主工具 `start_session`：Agent 为独立子任务另开会话（独立 worktree），在侧栏显示并跟踪结果，完成后汇报给发起会话 |
| M3-05 | 远程控制 | 主进程内置 HTTPS + WebSocket 服务（默认关闭）；局域网二维码配对（一次性令牌，可随时吊销）；手机端响应式页面复用对话组件，可查看会话、发消息、审批、切换模型；公网中继另行评估 |
| M3-06 | SSH 远程开发 | 通过 SSH 在远程主机启动 `dcode --ide-server`，NDJSON 直接走 SSH 标准输入输出，复用全部界面；远程主机未安装时可一键上传内核；文件与 Git 面板经 SFTP / 远程命令实现 |
| M3-07 | 富输出 | 对话内渲染 Mermaid 图与数据图表；Agent 生成的 HTML 产物在沙箱 iframe 中预览，可导出或在浏览器打开 |
| M3-08 | 跨平台 | macOS（arm64 / x64，签名与公证）与 Linux（AppImage / deb）构建，CI 原生运行器验收 |

**暂不规划**：云端运行（任务在服务器上执行、电脑休眠也继续）需要服务端基础设施与账号体系，等 M3 远程控制稳定后再评估。

**验收标准**：

- 安装一个 MCP 服务器与一个 Skill，在对话中成功调用；任一扩展崩溃不影响其他扩展与主界面。
- 定时任务按计划执行并留下可查看的运行记录。
- 手机在局域网内配对后可完成一次完整对话与审批；吊销令牌后立即失效。
- 通过 SSH 在远程 Linux 主机上完成一次带文件修改的回合。
- macOS 与 Linux 安装包在原生运行器上通过 E2E 冒烟测试。

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 协议扩展破坏终端或 VS Code 扩展 | 只增不改；新增字段均可选；协议测试覆盖新旧消息 |
| 长会话流式渲染卡顿 | 增量合并、只重渲染最后一条消息、虚拟列表；以体验指标做性能回归 |
| 内核进程崩溃或卡死 | 监控退出码，自动重启并恢复会话；`ready` 超时给出诊断 |
| 多内核进程占用资源 | 空闲 10 分钟自动回收；同时运行的会话数可配置上限 |
| 按块回退与 Agent 后续编辑冲突 | 回退前写检查点；回退只在该会话空闲时可用 |
| 渲染进程越权 | 沙箱 + IPC 白名单 + 主进程路径校验 |
| 升级时文件被占用 | 应用侧先结束进程树，NSIS 兜底；CI 实测升级路径 |
| 安装包未签名被拦截 | 发布说明写明 SmartScreen 处理方式并提供 SHA-256；后续评估代码签名 |
| 安装包体积约 100 MB | Electron 方案的固有代价，换取免装 Node 与开发效率；不额外打包 Git |
| 宿主工具调用挂起导致回合卡住 | 统一超时（`ask_user` 除外）；回合取消时结束全部未完成调用；宿主断开时返回明确错误 |
| 并行 worktree 占用磁盘、残留分支 | worktree 放在 `~/.dcode/worktrees`，会话归档或删除时提示清理；设置页显示占用空间并可一键清理 |
| node-pty 原生模块与 Electron 版本不匹配 | 构建时按 Electron 版本预编译并在 CI 冒烟测试；加载失败时终端功能降级提示，不影响其他功能 |
| 内置浏览器被引导访问恶意页面 | 默认只允许 localhost；其他域名逐个授权；页面内容作为数据交给 Agent，不当作指令 |
| 远程控制暴露本机能力 | 默认关闭；仅局域网；一次性配对令牌可吊销；所有写操作与命令仍走审批 |

## 11. 验证方案

以下为 M1 的验证方案；M2、M3 的验收标准见第 9.2、9.3 节，测试手段沿用本节的单元测试、模拟供应商 E2E 与 CI 原生运行器。

1. **内核**：`npm run typecheck`、`npm test`（含新增协议测试与 10 MB 会话分页测试）全部通过；VS Code 扩展类型检查通过，旧协议行为不变。
2. **本地安装**：`dcode.cmd --version` 正确，提示音资源存在。
3. **桌面端单元测试**：vitest 测试 Zustand 归约逻辑（流式拼接、工具卡片状态、权限流转、本轮改动汇总、历史分页回放）与主进程服务（路径校验、按块回退、设置备份）。
4. **端到端**：本地模拟的 OpenAI 兼容 SSE 服务（返回文本、思维链、一次 `edit_file` 与一次 `run_command` 工具调用），`custom` 供应商指向它；用 Playwright 的 Electron 驱动验证：流式显示、思维链折叠、风险分级权限卡片与快捷键审批、文件被修改、“本轮改动”卡片、按块回退与撤销本轮、文件树与变更面板刷新、会话归档与恢复、内核被强制结束后自动恢复。
5. **体验指标**：脚本化测量冷启动、`ready`、首 token 额外延迟、长会话加载与滚动帧率、空闲内存，对照第 5 节目标。
6. **打包与升级**：生成 NSIS 安装包，在 PATH 中没有 Node 的环境下安装并启动；从上一版覆盖升级（运行中的应用与内核须被正确结束）；完成一次真实供应商对话；卸载后 `~/.dcode` 保留。
