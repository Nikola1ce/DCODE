# DCODE

> 多 Provider 命令行 AI 编程助手（默认智谱 AI 免费模型）
>
> 制作人：**Moriarty_Dox**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)

DCODE 是一个运行在终端中的 AI 编程助手，借鉴 Claude Code 的整体架构（Agent 主循环 + 工具系统 + 全屏 TUI + 斜杠命令 + 会话/记忆/上下文压缩），并支持 **智谱 AI、DeepSeek、OpenAI** 等 OpenAI 兼容 API。**默认使用智谱 AI 的免费模型**（`glm-4-flash`），只需在 [智谱开放平台](https://open.bigmodel.cn/usercenter/apikeys) 获取 API Key 即可**零成本**开始编程对话；也可随时切换至 DeepSeek / OpenAI 等其它 Provider。

相对 Claude Code，DCODE 已完成 **MCP、子代理、后台 Shell、Web 工具、Hooks、Skills、文件检查点、Git 集成、多 Provider** 等核心能力（详见 [功能对比与路线图](docs/优化计划_DCODE_vs_ClaudeCode.md)）。

```
 _____     _____    ____    _____    ______
|  __ \   / ____|  / __ \  |  __ \  |  ____|
| |  | | | |      | |  | | | |  | | | |__
| |  | | | |      | |  | | | |  | | |  __|
| |__| | | |____  | |__| | | |__| | | |____
|_____/   \_____|  \____/  |_____/  |______|
```

## 目录

- [特性](#特性)
- [环境要求](#环境要求)
- [快速开始（5 分钟）](#快速开始5-分钟)
- [安装](#安装)
  - [免命令安装（Release 安装包，推荐）](#免命令安装release-安装包推荐)
  - [从 GitHub 克隆安装](#从-github-克隆安装)
  - [Windows 详细步骤](#windows-详细步骤)
  - [macOS / Linux 详细步骤](#macos--linux-详细步骤)
  - [卸载](#卸载)
- [配置 API Key 与 LLM Provider](#配置-api-key-与-llm-provider)
- [配置 MCP Server](#配置-mcp-server)
- [配置 Web 搜索](#配置-web-搜索)
- [Hooks 钩子](#hooks-钩子)
- [Skills 技能包](#skills-技能包)
- [文件检查点与回滚](#文件检查点与回滚)
- [Git 工作流](#git-工作流)
- [新手教学](#新手教学)
- [使用](#使用)
- [交互界面内的斜杠命令](#交互界面内的斜杠命令)
- [权限模式说明](#权限模式说明)
- [安全说明](#安全说明)
- [后台命令工作流](#后台命令工作流)
- [项目记忆（DCODE.md）](#项目记忆dcode)
- [常见问题](#常见问题)
- [开发](#开发)
- [功能路线图](#功能路线图)
- [开源协议](#开源协议)

## 特性

### 核心 Agent 与 Provider

- **多 Provider 支持**：默认 **智谱 AI** + 免费模型 `glm-4-flash` / `glm-4.7-flash`（`/model` 中带 **★**）；另支持 DeepSeek、OpenAI；`/provider` 切换供应商，`/proxy` 配置代理；状态栏与 `/cost` 按 Provider **预估成本**（免费模型显示「免费」）。
- **DeepSeek V4 原生适配**：`deepseek-v4-flash` / `deepseek-v4-pro`，工具调用与思维链 `reasoning_content`；旧别名 `deepseek-chat` / `deepseek-reasoner` 仍兼容（**2026-07-24 UTC 起官方下线**）。
- **流式输出**：边生成边显示，支持 `Esc` 中断；兼容各 Provider 的累积/重复 chunk 归一化，避免回答复读。
- **上下文自动压缩**：对话过长时自动摘要；`/compact` 可手动触发。
- **会话持久化**：`~/.dcode/sessions/`，`-c` 继续 / `-r` 恢复。
- **项目记忆**：读取 `DCODE.md`；`/init` 可自动生成。

### 工具系统（Function Calling）

- **文件与代码**：`read_file`、`write_file`、`edit_file`、`list_dir`、`glob`、`grep`
- **命令行**：`run_command`（支持 `background=true`）、`bash_output`（含 `tail` 增量）、`kill_shell`
- **协作与联网**：`task` 子代理并行、`todo_write` 任务清单、`web_fetch`、`web_search`
- **MCP 动态工具**：连接 MCP Server 后注册 `mcp__*` 工具，及 `list_mcp_resources` 等代理工具

### 工程能力（对标 Claude Code 已落地）

- **MCP Client**：`~/.dcode/mcp.json` / `.dcode/mcp.json`，`/mcp` 管理连接
- **子代理（Task）**：主 Agent 可并行派遣子任务，`/subagents` 查看状态
- **后台 Shell**：长时构建/测试不阻塞主循环，界面有后台面板，`/shells` 查看
- **Hooks**：`PreToolUse` / `PostToolUse` 等事件钩子，`/hooks` 查看与 reload
- **Skills**：可复用 Markdown 技能包，`/skill list` 加载领域工作流
- **文件检查点**：`write_file` / `edit_file` 前自动备份，`/checkpoints`、`/undo` 回滚
- **Git 集成**：`/commit` 生成 Conventional Commits 并提交，`/pr` 生成 PR 描述（可选 `gh`）

### 体验与安全

- **权限门控**：写文件、执行命令、Web/MCP 等需授权；`plan` / `auto` / `bypass` 模式可切换
- **网络安全**：`web_fetch` 禁止内网/localhost；DNS 解析复核、手动跟随重定向（防 SSRF）；拦截十进制/简写 IP
- **项目信任**：项目级 `.dcode/mcp.json`、`.dcode/hooks.json` 仅在创建 **`.dcode/trust`**（或 `DCODE_TRUST_PROJECT=1`）后加载，降低打开陌生仓库时的供应链风险
- **密钥与进程隔离**：`~/.dcode/config.json` 写入时尝试 `chmod 600`；Shell / Hooks 子进程剔除 API Key 等敏感环境变量
- **路径与并发**：文件工具通过 `realpath` 校验工作区内路径；同路径 `read_file` / `write_file` / `edit_file` 串行执行；「总是允许」按具体文件路径生效
- **上下文压缩**：自动压缩时保持 `assistant` + `tool` 消息组完整，避免 API 历史断裂
- **检查点回滚**：`/undo` 恢复失败时保留 manifest 条目，可再次尝试
- **精美终端 UI**：Ink 全屏 TUI，暗/亮主题，斜杠命令补全（`/` 底部展示 Provider 子选项）
- **成本追踪**：token 用量与预估成本（区分缓存命中/未命中）

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | **>= 18**（推荐 20 或 24 LTS） |
| npm | 随 Node.js 自带即可 |
| 终端 | Windows Terminal、PowerShell、macOS Terminal、Linux 任意终端 |
| API Key | **默认智谱 AI**：在 [智谱开放平台](https://open.bigmodel.cn/usercenter/apikeys) 注册并创建 Key（免费模型无需充值）；亦可使用 [DeepSeek](https://platform.deepseek.com) / [OpenAI](https://platform.openai.com/api-keys) |

验证 Node.js 是否已安装：

```bash
node -v    # 应显示 v18.x 或更高
npm -v
```

若未安装 Node.js，请前往 [https://nodejs.org](https://nodejs.org) 下载 LTS 版本。

## 快速开始（5 分钟）

**不想敲命令？** 直接看 [免命令安装（Release 安装包）](#免命令安装release-安装包推荐)：下载 ZIP → 解压 → 双击 `启动 DCODE.bat`。

开发者可按顺序完成以下五步：

```bash
# 1. 克隆仓库
git clone https://github.com/Nikola1ce/DCODE.git
cd DCODE

# 2. 安装依赖并构建
npm install
npm run build

# 3. 全局安装（注册 dcode 命令）
npm install -g .

# 4. 设置 API Key（默认智谱 AI，见下文「配置 API Key 与 LLM Provider」）
export ZHIPU_API_KEY="你的智谱密钥"   # macOS / Linux（推荐，配合默认免费模型）
# $env:ZHIPU_API_KEY="你的智谱密钥"   # Windows PowerShell
# 若使用 DeepSeek：export DEEPSEEK_API_KEY="sk-..."

# 5. 进入你的项目目录，启动 DCODE
cd /path/to/your-project
dcode
```

首次启动后，在输入框中用自然语言描述任务即可，例如：

```
帮我分析这个项目的目录结构，并列出主要入口文件
```

## 安装

### 免命令安装（Release 安装包，推荐）

> 无需 `git clone`、`npm install`、`npm run build`，下载解压后**双击即可运行**。

**1. 下载**

打开 [GitHub Releases](https://github.com/Nikola1ce/DCODE/releases/latest)，下载 **`DCODE-vX.X.X-portable.zip`**。

**2. 安装 Node.js（仅首次，一次性）**

若尚未安装 Node.js，前往 [https://nodejs.org](https://nodejs.org) 下载 **LTS** 安装包，安装时勾选 **Add to PATH**。

**3. 解压并运行**

将 ZIP 解压到任意目录（例如 `D:\Tools\DCODE`），然后：

| 方式 | 操作 |
| --- | --- |
| **双击即用** | 双击 **`启动 DCODE.bat`**，按提示输入项目文件夹路径（回车则使用桌面） |
| **安装到本机** | 双击 **`安装到本机.bat`**（只需一次），重开终端后在任意项目目录输入 `dcode` |
| **macOS / Linux** | 终端执行 `chmod +x dcode.sh && ./dcode.sh` |

解压后的目录结构示例：

```
DCODE-v1.0.0/
├── dist/cli.js          # 已预构建，无需 npm
├── 启动 DCODE.bat       # Windows 双击启动
├── 安装到本机.bat       # Windows 一键注册 dcode 命令
├── dcode.bat / dcode.sh # 命令行启动器
├── 安装说明.txt
└── LICENSE
```

首次运行后，可在同目录编辑 **`工作目录.txt`** 修改默认项目路径；API Key 与 Provider 配置见下文 [配置 API Key 与 LLM Provider](#配置-api-key-与-llm-provider)。

---

### 从 GitHub 克隆安装

适合开发者或需要修改源码的用户：

```bash
git clone https://github.com/Nikola1ce/DCODE.git
cd DCODE
npm install
npm run build
npm install -g .
dcode --version
```

应输出：`DCODE v1.0.0（制作人：Moriarty_Dox）`

> **说明**：源码仓库不包含 `dist/`（已在 `.gitignore` 中忽略），克隆后必须先执行 `npm run build`。若不想构建，请使用上方 **Release 安装包**。

也可以不克隆，直接指定 GitHub 路径安装（同样会先构建）：

```bash
npm install -g github:Nikola1ce/DCODE
```

### 全局安装（本地目录）

若你已下载源码压缩包或本地已有项目目录：

```bash
cd /path/to/DCODE
npm install
npm run build
npm install -g .          # 推荐：正式全局安装
# npm link                # 开发调试：改代码后需重新 build
```

### Windows 详细步骤

**1. 安装 Node.js**

- 访问 [https://nodejs.org](https://nodejs.org)，下载 **LTS** 安装包
- 安装时勾选 **Add to PATH**
- 打开 **PowerShell** 或 **Windows Terminal**，验证：

```powershell
node -v
npm -v
```

**2. 克隆并安装 DCODE**

```powershell
# 进入你想存放项目的目录，例如桌面
cd $env:USERPROFILE\Desktop

# 克隆（若未安装 git，可从 GitHub 页面 Download ZIP 后解压）
git clone https://github.com/Nikola1ce/DCODE.git
cd DCODE

npm install
npm run build
npm install -g .
```

**3. 验证安装**

```powershell
dcode --version
```

**4. 若提示「找不到 dcode 命令」**

```powershell
# 查看 npm 全局安装路径
npm config get prefix
# 常见结果：C:\Users\你的用户名\AppData\Roaming\npm

# 将该路径加入系统环境变量 PATH，然后重开终端
# 设置 → 系统 → 关于 → 高级系统设置 → 环境变量 → Path → 新建 → 粘贴上述路径
```

**5. 配置 API Key 并启动**

```powershell
# 智谱 AI（默认，免费模型；Key 见 https://open.bigmodel.cn/usercenter/apikeys）
$env:ZHIPU_API_KEY="你的智谱密钥"
cd C:\path\to\your-project
dcode
```

### macOS / Linux 详细步骤

```bash
# 安装 Node.js（若尚未安装）
# macOS（Homebrew）：
brew install node

# Ubuntu / Debian：
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 克隆并安装
git clone https://github.com/Nikola1ce/DCODE.git
cd DCODE
npm install
npm run build
npm install -g .

# 验证
dcode --version

# 配置 Key 并启动（默认智谱 AI 免费模型）
export ZHIPU_API_KEY="你的智谱密钥"
cd ~/your-project
dcode
```

### 卸载

**npm 全局安装：**

```bash
npm uninstall -g dcode
# 若曾使用 npm link，可额外执行：
npm unlink -g dcode
```

**Windows 便携包「安装到本机」：**

双击 release 包内的 `从本机卸载.bat`，或执行：

```powershell
powershell -ExecutionPolicy Bypass -File uninstall-windows.ps1
```

会移除 `%LOCALAPPDATA%\DCODE`、用户 PATH 中的 `bin` 目录及开始菜单快捷方式；**不会**删除 `~/.dcode/` 中的 API Key 与会话。

本地克隆目录或便携 ZIP 解压文件夹可直接删除。

## 配置 API Key 与 LLM Provider

> **推荐新手路径（完全免费）**  
> DCODE **默认 Provider 为智谱 AI**，默认模型为 **`glm-4-flash`（永久免费）**。你只需：
> 1. 打开 [智谱 AI 开放平台 · API Keys](https://open.bigmodel.cn/usercenter/apikeys) 注册/登录  
> 2. 创建 API Key 并复制保存  
> 3. 运行 `dcode`，按提示 `/login` 粘贴 Key，或设置环境变量 `ZHIPU_API_KEY`  
>  
> 无需充值即可使用免费模型（`/model` 中带 **★** 标记的 `glm-4-flash`、`glm-4.7-flash`）。状态栏**预估成本**会显示「免费」。若需更强能力，可在 `/model` 中选择智谱按量计费模型，或 `/provider deepseek` / `/provider openai` 切换供应商。

### 支持的 Provider

| Provider | 环境变量 | 默认模型 | 说明 |
| --- | --- | --- | --- |
| **智谱 AI**（**默认**） | `ZHIPU_API_KEY` | `glm-4-flash` | **免费模型可用**；Key 在 [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys) 获取 |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` | [platform.deepseek.com](https://platform.deepseek.com) |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` | [platform.openai.com](https://platform.openai.com/api-keys)；国内通常需配置 `/proxy` |

运行中切换：`/provider zhipu`、`/provider deepseek`、`/provider openai`。切换后会自动改用该 Provider 的默认模型（若当前模型不属于目标供应商）。`DEEPSEEK_BASE_URL` 环境变量**仅**在 Provider 为 `deepseek` 时覆盖端点。查看状态：`/config`、`/provider`。

### 配置 Key 的三种方式

优先级：**环境变量 > 配置文件 > 交互式输入**

#### 方式一：交互式（最简单）

首次运行 `dcode`，界面会引导你输入 Key，自动保存到 `~/.dcode/config.json`（按当前 Provider 写入对应字段）。之后可随时输入 `/login` 重新设置。

#### 方式二：环境变量（推荐用于 CI / 临时切换）

```bash
# PowerShell — 智谱 AI（默认，免费模型）
$env:ZHIPU_API_KEY="你的智谱密钥"

# bash / zsh
export ZHIPU_API_KEY="你的智谱密钥"

# 其它 Provider（可选）
# $env:DEEPSEEK_API_KEY="sk-..."
# $env:OPENAI_API_KEY="sk-..."

# 信任当前项目的 MCP/Hooks 配置（可选，见「安全说明」）
# $env:DCODE_TRUST_PROJECT="1"
```

持久化（bash）：

```bash
echo 'export ZHIPU_API_KEY="你的智谱密钥"' >> ~/.bashrc
source ~/.bashrc
```

#### 方式三：手动编辑配置文件

创建或编辑 `~/.dcode/config.json`（智谱 AI 默认示例）：

```json
{
  "provider": "zhipu",
  "apiKey": "你的智谱密钥",
  "baseURL": "https://open.bigmodel.cn/api/paas/v4",
  "model": "glm-4-flash"
}
```

DeepSeek 示例：

```json
{
  "provider": "deepseek",
  "apiKey": "sk-你的密钥",
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-v4-flash"
}
```

### 获取智谱 API Key（免费起步）

1. 打开 [https://open.bigmodel.cn/usercenter/apikeys](https://open.bigmodel.cn/usercenter/apikeys) 并注册/登录  
2. 点击「创建 API Key」，复制密钥（只显示一次，请妥善保存）  
3. 在 DCODE 中 `/login` 或设置 `ZHIPU_API_KEY`  
4. 使用 `/model` 选择带 **★ 永久免费** 标记的模型即可零成本对话  

### 获取 DeepSeek API Key（可选）

1. 打开 [https://platform.deepseek.com](https://platform.deepseek.com) 并注册/登录  
2. 进入「API Keys」页面，点击「创建 API Key」  
3. 复制以 `sk-` 开头的密钥  
4. `/provider deepseek` 后配置 `DEEPSEEK_API_KEY` 或 `/login`  
5. 按量计费，请确保账户有余额  

## 配置 MCP Server

DCODE 作为 **MCP Client**，可连接任意 MCP Server 并将工具动态注册到 Agent。配置文件：

- 全局：`~/.dcode/mcp.json`（始终加载）
- 项目（可选）：`.dcode/mcp.json`（**需先信任项目**，见 [安全说明](#安全说明)）

格式与 Cursor 的 `mcp.json` 兼容，示例见 [docs/mcp.json.example](docs/mcp.json.example)：

```json
{
  "mcpServers": {
    "my-tool": {
      "command": "node",
      "args": ["path/to/mcp-server.js"],
      "env": { "API_KEY": "..." }
    },
    "remote": {
      "url": "http://localhost:3000/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

- **stdio**：`command` + `args`（本地进程）
- **HTTP**：`url` + `type: "http"`（Streamable HTTP，推荐）
- **SSE**：`url` + `type: "sse"`（兼容旧 Server）
- **`trust: true`**：该 Server 的 MCP 工具跳过授权弹窗（仍受 plan 模式约束；**不信任** MCP 自报的 `readOnlyHint`）

运行中可用 `/mcp` 查看连接状态，`/mcp reload` 热重载。模型还可使用内置代理工具：`list_mcp_resources`、`read_mcp_resource`、`list_mcp_prompts`、`get_mcp_prompt`。

## 配置 Web 搜索

`web_fetch` 可直接使用（抓取公开 http/https 页面，执行前需用户授权）。访问前会校验 URL、解析 DNS 并手动处理重定向，**禁止** localhost、内网 IP 及 DNS 重绑定至内网。`web_search` 需配置以下环境变量之一：

| 变量 | 说明 |
| --- | --- |
| `SERPAPI_API_KEY` | [SerpAPI](https://serpapi.com/) Key（优先使用，Google 引擎） |
| `BING_SEARCH_API_KEY` | [Bing Web Search API v7](https://www.microsoft.com/en-us/bing/apis/bing-web-search-api) Key |

```bash
# PowerShell
$env:SERPAPI_API_KEY="your-key"

# bash
export SERPAPI_API_KEY="your-key"
```

`web_fetch` 与 `web_search` 在 **plan 模式**下不可用；默认模式下执行前会弹出授权确认。

## Hooks 钩子

在工具执行前后插入自定义逻辑（lint、格式化、阻断危险操作等）。配置位置：

- 全局：`~/.dcode/hooks.json`、`~/.dcode/hooks/*.json`（始终加载）
- 项目：`<项目>/.dcode/hooks.json`、`<项目>/.dcode/hooks/*.json`（**需先信任项目**，见 [安全说明](#安全说明)）

支持事件类型包括 `PreToolUse`、`PostToolUse`、`Notification`、`OnSessionStart`、`OnSessionEnd` 等。Hook 可配置为 shell 命令；`PreToolUse` 可阻止工具执行或修改参数。Hook 子进程不会继承 API Key 等敏感环境变量。

```bash
/hooks          # 查看当前已加载钩子
/hooks reload   # 修改配置后重新加载
```

可在 `config.json` 中设置 `"hooksEnabled": true`（默认随项目启用）。详见 [优化计划 · Hooks](docs/优化计划_DCODE_vs_ClaudeCode.md#5-hooks-系统)。

## Skills 技能包

将常见任务沉淀为可复用 Markdown 技能，加载后注入系统提示。存放位置：

- 全局：`~/.dcode/skills/<name>/SKILL.md`
- 项目：`.dcode/skills/<name>/SKILL.md`

文件含 YAML frontmatter（`name`、`description`）与正文指令。首次运行会写入若干内置模板。

| 命令 | 说明 |
| --- | --- |
| `/skill list` | 列出可用技能 |
| `/skill <名称>` | 加载技能到当前会话 |
| `/skill unload` | 卸载已加载技能 |
| `/skill create <名称>` | 从当前对话摘要创建新技能 |

## 文件检查点与回滚

`write_file`、`edit_file` 成功执行前会自动将原文件备份到 `.dcode/checkpoints/`（建议加入 `.gitignore`）。

| 命令 | 说明 |
| --- | --- |
| `/checkpoints` | 查看备份列表（时间、路径、大小） |
| `/checkpoints clear` | 清空全部检查点 |
| `/undo` | 回退最近 **1** 个检查点 |
| `/undo 3` | 回退最近 3 个检查点 |

若某次回退因备份丢失等原因失败，对应条目会**保留在列表中**，可修正后再次 `/undo`。

多步 AI 改码出错时，可快速回滚而无需手动 `git checkout`。

## Git 工作流

| 命令 | 说明 |
| --- | --- |
| `/commit` | 读取 `git diff --staged`，生成 Conventional Commits 信息，确认后执行 `git commit` |
| `/pr` | 根据分支变更生成 PR 标题与 Markdown 描述 |
| `/pr create` | 若已安装 [GitHub CLI](https://cli.github.com/)（`gh`），可尝试直接创建 PR |

提交与 push 前均需用户确认。Agent 也可通过 `run_command` 调用 git，但推荐优先使用上述斜杠命令以获得更规范的摘要。

## 新手教学

### 第一课：第一次对话

1. 在终端进入你的项目根目录（DCODE 会以此目录为工作区）
2. 运行 `dcode`
3. 看到 ASCII LOGO 和欢迎横幅后，在底部输入框输入：

```
这个项目是做什么的？请阅读 README 和主要源码后简要说明。
```

4. 观察 DCODE 自动调用 `list_dir`、`read_file` 等工具分析项目
5. 当弹出权限确认（写文件 / 执行命令）时，用 `↑/↓` 选择「允许一次」或「总是允许」

### 第二课：让 DCODE 修改代码

```
在 src/constants.ts 的 VERSION 注释里加一行「开源版本」，不要改版本号本身。
```

- 默认模式下，**写文件前会弹出确认**，请仔细看清要修改的路径
- 若你信任当前任务，可输入 `/auto` 切换为自动接受编辑（命令执行仍需确认）
- 运行中按 `Esc` 可随时中断

### 第三课：使用斜杠命令

在输入框键入 `/` 会自动弹出命令菜单（底部含 **Provider 子选项**：`/provider zhipu` 等）：

| 你想做的事 | 输入 |
| --- | --- |
| 查看所有命令 | `/help` |
| 切换 Provider（默认智谱免费） | `/provider zhipu` |
| 切换模型（★ 为免费） | `/model` |
| 查看预估 token 成本 | `/cost` |
| 连接 MCP 工具 | `/mcp list` |
| 查看后台构建任务 | `/shells` |
| 改码后一键回滚 | `/undo` |
| 生成 commit / PR | `/commit`、`/pr` |
| 加载技能包 | `/skill list` |
| 清空对话重来 | `/clear` |
| 生成项目记忆 | `/init` |
| 只读规划 | `/plan` |
| 退出 | `/exit` |

### 第四课：继续上次会话

```bash
# 在当前目录继续最近一次对话
dcode -c

# 从历史列表恢复
dcode -r
```

会话文件保存在 `~/.dcode/sessions/`，按工作目录区分。

### 第五课：无头模式（脚本 / 自动化）

不进入交互界面，执行一次任务并打印结果：

```bash
dcode -p "列出当前目录下所有 .ts 文件，并统计行数"

# 显式自动批准需授权操作（写文件、run_command、web_fetch 等）
dcode -p -y "运行 npm test 并总结失败用例"

# 管道传入
echo "检查 package.json 的依赖是否有已知安全问题" | dcode -p
```

> **注意**：无头模式**默认拒绝**需授权的操作（无 TUI 无法弹窗）。若任务会写文件或执行命令，请加上 **`-y` / `--yes`**，或使用 **`--bypass`**（危险）。`--plan` 仍为只读。

适合 CI、定时任务或快速一次性问答。无头模式同样会写入 `~/.dcode/sessions/`，stderr 会输出 `[会话已保存] <id>`，可用 `dcode -c` 继续。

### 第六课：项目记忆 DCODE.md

在项目根目录创建 `DCODE.md`，或在界面执行 `/init` 让 DCODE 自动生成。此后每次对话都会读取该文件，例如：

```markdown
# 项目说明
- 技术栈：TypeScript + Ink
- 构建：npm run build
- 测试：npx tsc --noEmit
- 注意：不要修改 dist/，由 build 生成
```

全局偏好可放在 `~/.dcode/DCODE.md`。

## 使用

```bash
# 启动交互式界面（默认智谱 glm-4-flash 免费模型）
dcode

# 指定模型启动
dcode --model glm-4.7-flash
dcode --model deepseek-v4-pro

# 无头模式：执行一次任务并打印结果（适合脚本/CI）
dcode -p "用 Python 写一个快速排序并附带测试"

# 无头 + 自动批准（任务含写文件/执行命令时使用）
dcode -p -y "运行 npm test 并修复失败用例"

# 用 V4 Pro + 最大推理强度（Thinking 模式下生效）
dcode --model deepseek-v4-pro --reasoning-effort max -p -y "设计一个 LRU 缓存类"

# 通过管道传入任务
echo "审查 src/index.ts 的潜在 bug" | dcode -p

# 继续当前目录最近一次会话
dcode -c

# 恢复历史会话（不带 id 则选最近一个）
dcode -r

# 以规划模式启动（只读，不修改文件/不执行命令）
dcode --plan
```

### 命令行选项

| 选项 | 说明 |
| --- | --- |
| `-p, --print` | 无头模式：执行一轮任务并打印后退出 |
| `-y, --yes` | 无头模式下自动批准权限请求（**默认拒绝**需授权操作） |
| `--dangerously-auto-approve` | 同 `-y` |
| `-c, --continue` | 继续当前目录最近一次会话 |
| `-r, --resume [id]` | 恢复指定（或最近）历史会话 |
| `-m, --model <模型>` | 指定模型（按当前 Provider 校验；智谱如 `glm-4-flash`，DeepSeek 见 `/model`） |
| `--cwd <目录>` | 指定工作目录 |
| `--plan` | 规划模式（只读） |
| `--auto` | 自动接受编辑模式（文件读写免确认） |
| `--bypass` | 跳过所有权限确认（危险；无头模式下等同自动批准） |
| `--dangerously-skip-permissions` | 同 `--bypass` |
| `--reasoning-effort <high\|max>` | 推理强度（Thinking 模式下生效；Pro 复杂任务可用 `max`） |
| `-v, --version` | 显示版本 |
| `-h, --help` | 显示帮助 |

## 交互界面内的斜杠命令

> 在输入框中键入 `/` 会**自动弹出命令补全菜单**：用 `↑`/`↓` 选择，`Tab` 补全命令名（便于继续输入参数），`回车` 执行选中命令，`Esc` 关闭菜单。继续输入字母会按前缀实时过滤候选；仅输入 `/` 时，**Provider 子选项**排在列表最底部。

| 命令 | 说明 |
| --- | --- |
| `/help` | 显示所有命令 |
| `/about` | 关于（版本与制作人） |
| `/model [名称]` | 查看或切换模型（智谱免费模型带 ★ 标记） |
| `/provider [id]` | 查看或切换 LLM Provider（`zhipu` / `deepseek` / `openai`） |
| `/proxy [地址\|clear]` | 查看或设置 HTTP(S) 代理（OpenAI 等国外 API 常用） |
| `/cost` | 显示 token 用量与预估成本 |
| `/clear` | 清空对话历史 |
| `/compact` | 立即压缩上下文 |
| `/init` | 分析项目并生成 `DCODE.md` |
| `/login` | 设置 / 更新当前 Provider 的 API Key |
| `/resume` | 从历史会话中恢复 |
| `/theme` | 切换暗/亮主题 |
| `/thinking` | 开关思维链展示 |
| `/effort [high\|max]` | 查看或切换推理强度（Thinking 模式下传给 API） |
| `/mcp [list\|resources\|prompts\|reload]` | 查看/管理 MCP Server 连接 |
| `/shells`（别名 `/bg`） | 查看后台 Shell 状态 |
| `/subagents`（别名 `/agents`） | 查看子代理（Task 工具）状态 |
| `/hooks [reload]` | 查看或重载 Hooks 钩子 |
| `/skill`（别名 `/skills`） | 技能包：list / 加载 / unload / create |
| `/checkpoints [clear]` | 查看或清空文件检查点 |
| `/undo [N]` | 回退最近 N 个文件检查点（默认 1） |
| `/commit` | 根据 staged 变更生成 commit 并提交 |
| `/pr [create]` | 生成 PR 描述（可选 gh 创建） |
| `/plan`、`/auto`、`/bypass` | 切换权限模式 |
| `/mode <plan\|auto\|bypass>` | 同上 |
| `/memory` | 显示已加载的记忆文件 |
| `/config` | 显示当前配置（隐藏密钥） |
| `/exit` | 退出 |

### 快捷键

- 键入 `/` 弹出命令补全菜单：`↑/↓` 选择、`Tab` 补全、`回车` 执行、`Esc` 关闭
- `Enter` 提交；`↑/↓`（非命令菜单时）浏览输入历史
- `←/→` 移动光标，`Ctrl+A`/`Ctrl+E` 行首/行尾，`Ctrl+U` 清空整行
- 运行中按 `Esc` 中断当前操作
- `Ctrl+C` 退出

## 权限模式说明

可用 `/plan`、`/auto`、`/bypass` 或启动参数 `--plan`、`--auto`、`--bypass` 切换：

| 模式 | 行为 |
| --- | --- |
| `plan` | 只读规划：禁止修改文件与执行命令 |
| `auto` | 文件读写免确认，命令执行仍需授权 |
| `bypass` | 跳过所有确认：文件读写与命令执行均直接进行（请谨慎使用） |

正常启动（未加上述参数）时，写文件与执行命令前会请求授权。

无头模式（`-p`）下无 TUI，**默认拒绝**需授权操作；加 `-y` 或 `--bypass` 才会自动执行。

## 安全说明

DCODE 在 Agent 能改代码、跑命令的前提下，默认采用偏保守的安全策略：

| 机制 | 说明 |
| --- | --- |
| **项目信任** | 在项目根创建空文件 `.dcode/trust`，或设置 `DCODE_TRUST_PROJECT=1`，才加载项目级 MCP / Hooks 配置 |
| **web_fetch** | 仅 http/https；禁止内网 IP；DNS 解析后复核；重定向每跳重新校验 |
| **无头权限** | `-p` 默认拒绝写文件/执行命令/Web；需 `-y` 或 `--bypass` |
| **MCP 授权** | 仅 Server 配置 `trust: true` 可跳过弹窗；不信任 MCP 的 `readOnlyHint` |
| **路径访问** | 文件工具限制在工作目录内，并解析符号链接 |
| **密钥存储** | API Key 存于 `~/.dcode/config.json`，保存时尝试限制为仅当前用户可读 |
| **子进程环境** | `run_command` / Hooks 子进程不继承 `*_API_KEY` 等敏感变量 |

在**你完全信任**的自有项目中，可按需创建 `.dcode/trust` 以启用项目级 MCP 与 Hooks。

长时间命令（构建、测试套件、训练脚本等）若在前台执行会阻塞 Agent 主循环。DCODE 支持将命令放到**后台**运行，再通过专用工具轮询输出或终止进程。

### 典型流程

```
1. run_command(background=true)  →  立即返回 shell_id
2. bash_output(shell_id, tail=true)  →  轮询增量输出（可多次调用）
3. kill_shell(shell_id)  →  需要时手动终止
```

界面底部会显示**后台 Shell 面板**（运行中任务折叠为一行摘要）；也可输入 `/shells` 查看列表。

### 工具参数说明

| 工具 | 关键参数 | 说明 |
| --- | --- | --- |
| `run_command` | `background: true` | 后台启动，返回 `shell_id`，不等待命令结束 |
| `run_command` | `description` | 建议填写，便于授权弹窗与 `/shells` 展示 |
| `bash_output` | `shell_id` | 必填，查询该后台进程的状态与输出 |
| `bash_output` | `block_until_ms` | 可选，短暂阻塞等待（毫秒），默认 0 |
| `bash_output` | `tail: true` | 可选，**仅返回自上次 tail 查询以来的新增输出**，适合长日志轮询 |
| `kill_shell` | `shell_id` | 终止仍在运行的后台进程（需用户授权） |

### 示例（Agent 视角）

后台启动构建并轮询增量日志：

```json
{ "command": "npm run build", "description": "构建项目", "background": true }
```

```json
{ "shell_id": "a1b2c3d4", "tail": true }
```

进程结束后 `bash_output` 会返回 `completed` 状态与最终退出码；若需提前停止：

```json
{ "shell_id": "a1b2c3d4" }
```

（`kill_shell` 调用）

### 限制与提示

- 后台 Shell 默认最长运行 **30 分钟**，超时自动终止。
- 历史记录最多保留 **30 条**（已结束的会被自动 purge）。
- `plan` 模式下仍禁止启动后台命令（与前台 `run_command` 相同）。
- `tail=true` 的「上次查询」按 **shell_id** 独立计数；首次 tail 调用返回当前已有全部输出。

## 项目记忆（DCODE.md）

在项目根目录放置 `DCODE.md`，DCODE 会在每次对话时将其内容注入系统提示，用于记录：

- 项目简介与技术栈
- 目录结构要点
- 常用命令（构建/测试/运行）
- 代码风格与约定、注意事项

也可直接在界面中执行 `/init`，让 DCODE 自动分析项目并生成该文件。全局偏好可放在 `~/.dcode/DCODE.md`。

## 常见问题

### `dcode` 不是内部或外部命令

- 确认已执行 `npm install -g .` 且 `npm run build` 成功
- 将 `npm config get prefix` 输出的路径加入系统 `PATH`
- **重开终端**后再试

### 启动后提示 API Key 无效或未设置

- 默认 Provider 为智谱 AI，环境变量名优先使用 **`ZHIPU_API_KEY`**
- DeepSeek 使用 `DEEPSEEK_API_KEY`，OpenAI 使用 `OPENAI_API_KEY`
- 检查 Key 无多余空格；智谱 Key 在 [开放平台](https://open.bigmodel.cn/usercenter/apikeys) 创建
- 在界面输入 `/login` 重新配置，或编辑 `~/.dcode/config.json`；用 `/config` 确认当前 Provider

### 不想用命令行怎么安装？

请使用 [Release 安装包](#免命令安装release-安装包推荐)：在 [Releases 页面](https://github.com/Nikola1ce/DCODE/releases) 下载 ZIP，解压后双击 **`启动 DCODE.bat`** 即可（仍需先安装 Node.js）。

### 克隆后运行 `dcode` 报错找不到 `dist/cli.js`

必须先构建：

```bash
npm install
npm run build
```

### Windows 下中文乱码

建议使用 **Windows Terminal**，并在设置中将字体改为支持中文的等宽字体（如 Cascadia Mono、Consolas）。

### 如何切换模型？

- 启动时：`dcode --model glm-4.7-flash` 或 `dcode --model deepseek-v4-pro`
- 运行中：`/model` 打开选择器，或 `/model glm-4-flash`
- 配置文件：修改 `~/.dcode/config.json` 中的 `"model"` 字段  
- 切换 Provider：`/provider zhipu`（默认免费）、`/provider deepseek`、`/provider openai`

### 费用如何计算？

输入 `/cost` 查看当前会话的 token 用量与**预估**美元成本。  
- **智谱免费模型**（`glm-4-flash`、`glm-4.7-flash`）：预估成本为 **免费**  
- 智谱按量计费模型、DeepSeek、OpenAI：按各自价目估算；状态栏显示「预估成本」

### 无头模式提示「已拒绝需授权的操作」

无头模式默认不弹授权框。若任务需要写文件或执行命令，请加上 **`-y`**：

```bash
dcode -p -y "你的任务描述"
```

或使用 `--plan` 做只读分析（不修改、不执行）。

### 项目 MCP / Hooks 未生效

项目级 `.dcode/mcp.json`、`.dcode/hooks.json` 需先**信任该项目**：

```bash
mkdir -p .dcode
touch .dcode/trust    # Windows: type nul > .dcode\trust
```

或临时：`DCODE_TRUST_PROJECT=1 dcode`（PowerShell：`$env:DCODE_TRUST_PROJECT="1"`）。

### `DEEPSEEK_BASE_URL` 与 Provider 切换

环境变量 `DEEPSEEK_BASE_URL` **仅**在 Provider 为 `deepseek` 时生效；切换到智谱/OpenAI 后不会误指向 DeepSeek 端点。

## 开发

```bash
git clone https://github.com/Nikola1ce/DCODE.git
cd DCODE
npm install
npm run dev     # 监听源码变更自动重建
npm run build   # 单次构建
npm run typecheck  # 类型检查（等同 npx tsc --noEmit）
npm test        # 运行单元测试（Vitest）
npm run test:watch  # 监听模式跑测试
```

源码采用 TypeScript + ESM，使用 esbuild 打包为单文件。单元测试位于 `src/**/*.test.ts`（Vitest，130+ 用例）。主要模块：

```
src/
├── cli.tsx              # CLI 入口与参数解析
├── constants.ts         # 品牌常量（含制作人署名）
├── config.ts            # ~/.dcode 配置管理
├── memory.ts            # DCODE.md 记忆加载
├── headless.ts          # 无头模式执行器
├── mcp/                 # MCP Client（连接 Server、动态工具）
├── providers/           # 多 Provider（zhipu / deepseek / openai）、代理、计费、流式归一化
├── deepseek/
│   ├── client.ts        # OpenAI 兼容流式客户端（SSE + 工具调用 + 重试）
│   └── pricing.ts       # 用量与成本（委托 providers/pricing）
├── core/
│   ├── agent.ts         # Agent 主循环
│   ├── subAgent.ts      # 子代理（Task）调度
│   ├── shellManager.ts  # 后台 Shell 生命周期
│   ├── hooks.ts         # Hooks 钩子系统
│   ├── projectTrust.ts  # 项目级 MCP/Hooks 信任标记
│   ├── childEnv.ts      # 子进程环境变量净化
│   ├── fileToolLock.ts  # 文件工具路径串行锁
│   ├── skills.ts        # Skills 技能包
│   ├── checkpoint.ts    # 文件检查点与 /undo
│   ├── gitUtils.ts      # Git diff / commit / PR 辅助
│   ├── systemPrompt.ts  # 系统提示构建
│   ├── compact.ts       # 上下文压缩（保持 tool 消息组完整）
│   ├── session.ts       # 会话持久化（JSONL）
│   └── types.ts         # 核心类型
├── tools/               # 工具系统（文件/命令/Web/Task/MCP 等；webUtils 含 SSRF 防护）
├── commands/            # 斜杠命令系统
└── ui/                  # Ink TUI 组件
```

欢迎提交 Issue 与 Pull Request！

## 功能路线图

| 阶段 | 状态 | 能力 |
| --- | --- | --- |
| **P0 核心** | ✅ 已完成 | MCP、子代理 Task、后台 Shell、Web Fetch/Search |
| **P1 工程** | ✅ 已完成 | Hooks、Skills、文件检查点、Git `/commit` `/pr` |
| **P2 体验** | 🔶 部分完成 | **多 Provider**（智谱/DeepSeek/OpenAI）、Provider 感知计费、流式去重、**安全加固**（SSRF/项目信任/无头权限） |
| **P2 待办** | ⏳ 规划中 | `.dcodeignore`、`/review`、IDE 扩展、图像多模态、自动更新等 |

## 开源协议

本项目采用 [MIT License](LICENSE) 开源。

---

DCODE · 制作人 **Moriarty_Dox** · [GitHub](https://github.com/Nikola1ce/DCODE)
