# DCODE

> 适配 DeepSeek 模型的命令行 AI 编程助手
>
> 制作人：**Moriarty_Dox**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)

DCODE 是一个运行在终端中的 AI 编程助手，借鉴 Claude Code 的整体架构（Agent 主循环 + 工具系统 + 全屏 TUI + 斜杠命令 + 会话/记忆/上下文压缩），并针对 **DeepSeek** 的 OpenAI 兼容 API 做了适配与优化。它能理解你的代码库、读写与编辑文件、执行命令、检索代码，并以对话方式完成完整的开发任务。

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
- [配置 API Key](#配置-api-key)
- [新手教学](#新手教学)
- [使用](#使用)
- [交互界面内的斜杠命令](#交互界面内的斜杠命令)
- [权限模式说明](#权限模式说明)
- [项目记忆（DCODE.md）](#项目记忆dcode)
- [常见问题](#常见问题)
- [开发](#开发)
- [开源协议](#开源协议)

## 特性

- **DeepSeek V4 原生适配**：支持 `deepseek-v4-flash`（默认，快速且经济）与 `deepseek-v4-pro`（推理/编码更强），均支持工具调用与思维链 `reasoning_content` 展示；旧别名 `deepseek-chat` / `deepseek-reasoner` 仍兼容（**2026-07-24 UTC 起官方下线**，请尽快改用 V4 模型名）。
- **流式输出**：边生成边显示，支持随时按 `Esc` 中断。
- **Function Calling 工具系统**：模型可自主调用以下工具完成任务
  - `read_file` 读取文件（带行号、可分段）
  - `write_file` 写入/创建文件
  - `edit_file` 精确字符串替换式编辑
  - `list_dir` 列目录
  - `glob` 按文件名模式查找（遵循 `.gitignore`）
  - `grep` 按正则搜索内容
  - `run_command` 执行命令（Windows 用 PowerShell，类 Unix 用 sh）
  - `todo_write` 维护任务清单（界面实时展示进度）
- **权限门控**：写文件、执行命令前会请求授权，可选择“允许一次 / 总是允许 / 拒绝”；支持 `plan`（只读）、`auto`（自动接受编辑）、`bypass`（跳过所有确认）三种模式切换。
- **会话持久化**：自动保存到 `~/.dcode/sessions/`，可用 `-c` 继续、`-r` 恢复。
- **项目记忆**：读取项目根目录的 `DCODE.md` 注入上下文；`/init` 可自动生成。
- **上下文自动压缩**：对话过长时自动摘要历史，释放上下文空间。
- **成本追踪**：实时统计 token 用量与预估费用（区分缓存命中/未命中价）。
- **MCP 协议支持**：连接 MCP Server，动态注册 `mcp__*` 工具，并可通过代理工具访问 Resources / Prompts（配置 `~/.dcode/mcp.json`，格式与 Cursor 兼容）。
- **精美终端 UI**：基于 Ink 的全屏交互界面，暗/亮主题可切换。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | **>= 18**（推荐 20 或 24 LTS） |
| npm | 随 Node.js 自带即可 |
| 终端 | Windows Terminal、PowerShell、macOS Terminal、Linux 任意终端 |
| API Key | [DeepSeek 开放平台](https://platform.deepseek.com) 注册并创建 |

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

# 4. 设置 API Key（任选一种方式，见下文「配置 API Key」）
export DEEPSEEK_API_KEY="sk-你的密钥"   # macOS / Linux
# $env:DEEPSEEK_API_KEY="sk-你的密钥"   # Windows PowerShell

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

首次运行后，可在同目录编辑 **`工作目录.txt`** 修改默认项目路径；API Key 配置见下文 [配置 API Key](#配置-api-key)。

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
$env:DEEPSEEK_API_KEY="sk-你的密钥"
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

# 配置 Key 并启动
export DEEPSEEK_API_KEY="sk-你的密钥"
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

## 配置 API Key

三选一（优先级：**环境变量 > 配置文件 > 交互式输入**）：

### 方式一：交互式（最简单）

首次运行 `dcode`，界面会引导你输入 Key，自动保存到 `~/.dcode/config.json`。之后可随时输入 `/login` 重新设置。

### 方式二：环境变量（推荐用于 CI / 临时切换）

```bash
# PowerShell
$env:DEEPSEEK_API_KEY="sk-你的密钥"

# bash / zsh
export DEEPSEEK_API_KEY="sk-你的密钥"
```

持久化（bash）：

```bash
echo 'export DEEPSEEK_API_KEY="sk-你的密钥"' >> ~/.bashrc
source ~/.bashrc
```

### 方式三：手动编辑配置文件

创建或编辑 `~/.dcode/config.json`：

```json
{
  "apiKey": "sk-你的密钥",
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-v4-flash"
}
```

**获取 Key 的步骤：**

1. 打开 [https://platform.deepseek.com](https://platform.deepseek.com) 并注册/登录
2. 进入「API Keys」页面，点击「创建 API Key」
3. 复制以 `sk-` 开头的密钥（只显示一次，请妥善保存）
4. 确保账户有余额或已开通按量计费

## 配置 MCP Server

DCODE 作为 **MCP Client**，可连接任意 MCP Server 并将工具动态注册到 Agent。配置文件：

- 全局：`~/.dcode/mcp.json`
- 项目（可选）：`.dcode/mcp.json`（同名 server 覆盖全局）

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
- **`trust: true`**：该 Server 的非只读 MCP 工具跳过授权弹窗（仍受 plan 模式约束）

运行中可用 `/mcp` 查看连接状态，`/mcp reload` 热重载。模型还可使用内置代理工具：`list_mcp_resources`、`read_mcp_resource`、`list_mcp_prompts`、`get_mcp_prompt`。

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

在输入框键入 `/` 会自动弹出命令菜单：

| 你想做的事 | 输入 |
| --- | --- |
| 查看所有命令 | `/help` |
| 切换更强模型 | `/model deepseek-v4-pro` |
| 查看 token 花费 | `/cost` |
| 清空对话重来 | `/clear` |
| 生成项目记忆文件 | `/init` |
| 切换暗/亮主题 | `/theme` |
| 只读规划、不改文件 | `/plan` |
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

# 管道传入
echo "检查 package.json 的依赖是否有已知安全问题" | dcode -p
```

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
# 启动交互式界面
dcode

# 用更强的 V4 Pro 模型启动
dcode --model deepseek-v4-pro

# 无头模式：执行一次任务并打印结果（适合脚本/CI）
dcode -p "用 Python 写一个快速排序并附带测试"

# 用 V4 Pro + 最大推理强度（Thinking 模式下生效）
dcode --model deepseek-v4-pro --reasoning-effort max -p "设计一个 LRU 缓存类"

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
| `-c, --continue` | 继续当前目录最近一次会话 |
| `-r, --resume [id]` | 恢复指定（或最近）历史会话 |
| `-m, --model <模型>` | 指定模型（`deepseek-v4-flash` / `deepseek-v4-pro`，默认 flash） |
| `--cwd <目录>` | 指定工作目录 |
| `--plan` | 规划模式（只读） |
| `--auto` | 自动接受编辑模式（文件读写免确认） |
| `--bypass` | 跳过所有权限确认（危险） |
| `--dangerously-skip-permissions` | 同 `--bypass` |
| `--reasoning-effort <high\|max>` | 推理强度（Thinking 模式下生效；Pro 复杂任务可用 `max`） |
| `-v, --version` | 显示版本 |
| `-h, --help` | 显示帮助 |

## 交互界面内的斜杠命令

> 在输入框中键入 `/` 会**自动弹出命令补全菜单**：用 `↑`/`↓` 选择，`Tab` 补全命令名（便于继续输入参数），`回车` 执行选中命令，`Esc` 关闭菜单。继续输入字母会按前缀实时过滤候选。

| 命令 | 说明 |
| --- | --- |
| `/help` | 显示所有命令 |
| `/about` | 关于（版本与制作人） |
| `/model [名称]` | 查看或切换模型 |
| `/cost` | 显示 token 用量与预估成本 |
| `/clear` | 清空对话历史 |
| `/compact` | 立即压缩上下文 |
| `/init` | 分析项目并生成 `DCODE.md` |
| `/login` | 设置 / 更新 API Key |
| `/resume` | 从历史会话中恢复 |
| `/theme` | 切换暗/亮主题 |
| `/thinking` | 开关思维链展示 |
| `/effort [high\|max]` | 查看或切换推理强度（Thinking 模式下传给 API） |
| `/mcp [list\|resources\|prompts\|reload]` | 查看/管理 MCP Server 连接 |
| `/plan`、`/auto`、`/bypass` | 切换权限模式：规划（只读）/ 自动接受编辑 / 跳过所有确认 |
| `/mode <plan\|auto\|bypass>` | 同上，例如 `/mode bypass` |
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

- 检查 Key 是否以 `sk-` 开头、无多余空格
- 环境变量名必须为 `DEEPSEEK_API_KEY`
- 在界面输入 `/login` 重新配置，或编辑 `~/.dcode/config.json`

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

- 启动时：`dcode --model deepseek-v4-pro`
- 运行中：`/model deepseek-v4-pro`
- 配置文件：修改 `~/.dcode/config.json` 中的 `"model"` 字段

### 费用如何计算？

输入 `/cost` 查看当前会话的 token 用量与预估美元成本。`deepseek-v4-flash` 更经济，复杂推理/编码任务可选用 `deepseek-v4-pro`。

## 开发

```bash
git clone https://github.com/Nikola1ce/DCODE.git
cd DCODE
npm install
npm run dev     # 监听源码变更自动重建
npm run build   # 单次构建
npm run typecheck  # 类型检查（等同 npx tsc --noEmit）
```

源码采用 TypeScript + ESM，使用 esbuild 打包为单文件。主要模块：

```
src/
├── cli.tsx              # CLI 入口与参数解析
├── constants.ts         # 品牌常量（含制作人署名）
├── config.ts            # ~/.dcode 配置管理
├── memory.ts            # DCODE.md 记忆加载
├── headless.ts          # 无头模式执行器
├── mcp/                 # MCP Client（连接 Server、动态工具）
├── deepseek/
│   ├── client.ts        # DeepSeek 流式客户端（SSE + 工具调用合并 + 重试）
│   └── pricing.ts       # 用量与成本计算
├── core/
│   ├── agent.ts         # Agent 主循环
│   ├── systemPrompt.ts  # 系统提示构建
│   ├── compact.ts       # 上下文压缩
│   ├── session.ts       # 会话持久化（JSONL）
│   └── types.ts         # 核心类型
├── tools/               # 工具系统（读/写/编辑/列目录/glob/grep/命令/todo）
├── commands/            # 斜杠命令系统
└── ui/                  # Ink TUI 组件
```

欢迎提交 Issue 与 Pull Request！

## 开源协议

本项目采用 [MIT License](LICENSE) 开源。

---

DCODE · 制作人 **Moriarty_Dox** · [GitHub](https://github.com/Nikola1ce/DCODE)
